import { createHash } from "node:crypto";
import { readBytesInside } from "./safefs.js";
import { parse as parseToml } from "smol-toml";
import { Recipe, RECIPE_FILE, type Lane, type Project, type RecipeView } from "@contextlanes/protocol";
import type { Store } from "./db/store.js";

const MAX_BYTES = 64 * 1024;

/** The hash covers the file's exact bytes, so any edit, even whitespace, needs approval again. */
export async function readRecipe(store: Store, project: Project, dir: string): Promise<RecipeView | null> {
  const file = await readBytesInside(dir, RECIPE_FILE, MAX_BYTES + 1);
  if (!file) return importRecipe(store, project, dir);
  const hash = createHash("sha256").update(file.data).digest("hex");
  const view = { file: RECIPE_FILE, hash, text: file.data.toString("utf8"), approved: store.recipeApproved(project.id, hash) };
  if (file.size > MAX_BYTES) return { ...view, recipe: null, error: "The recipe is larger than 64 KB." };
  try { return { ...view, recipe: Recipe.parse(JSON.parse(view.text)), error: null }; }
  catch (err) { return { ...view, recipe: null, error: err instanceof SyntaxError ? `Not valid JSON: ${err.message}` : "The recipe does not match the schema; check its keys and values." }; }
}

/** Imports are proposals only. Shell syntax needs an explicit native recipe, never a shell fallback. */
function importCommand(value: unknown): string[] {
  if (typeof value !== "string" || /[;&|<>`\\\n\r]/.test(value) || /\$(?!PORT(?:_[A-Z0-9_]+)?\b|HOST\b)/.test(value)) throw new Error("Shell syntax cannot be imported. Write argument arrays or a repository script path in .contextlanes.json.");
  const tokens = value.match(/"[^"$]*"|'[^'$]*'|[^\s"']+/g) ?? [];
  if (tokens.join(" ").replace(/\s+/g, " ") !== value.trim().replace(/\s+/g, " ")) throw new Error("Unmatched quotes in imported command.");
  const args = tokens.map((t) => /^["']/.test(t) ? t.slice(1, -1) : t);
  if (!args.length || args[0]!.includes("=") || args[0]!.startsWith("-")) throw new Error("Imported command needs an executable.");
  return args;
}

async function importRecipe(store: Store, project: Project, dir: string): Promise<RecipeView | null> {
  for (const [path, importedFrom] of [[".superset/config.json", "Superset"], [".conductor/settings.toml", "Conductor"], ["conductor.json", "Conductor"]] as const) {
    const file = await readBytesInside(dir, path, MAX_BYTES + 1);
    if (!file) continue;
    const source = file.data.toString("utf8");
    let recipe: Recipe | null = null, error: string | null = null;
    try {
      if (file.size > MAX_BYTES) throw new Error("The imported configuration is larger than 64 KB.");
      const data = (path.endsWith(".toml") ? parseToml(source) : JSON.parse(source)) as Record<string, unknown>;
      const scripts = (importedFrom === "Superset" ? data : data.scripts ?? {}) as Record<string, unknown>;
      const commands = (v: unknown) => (v === undefined ? [] : Array.isArray(v) ? v : [v]).map(importCommand);
      const setup = commands(scripts.setup).map((command, i) => ({ name: `Imported setup ${i + 1}`, command }));
      const teardown = commands(scripts.teardown ?? scripts.archive);
      let run = scripts.run;
      if (run && typeof run === "object" && !Array.isArray(run)) {
        const actions = Object.values(run as Record<string, { command?: string; default?: boolean }>);
        if (actions.length > 1 && !actions.some((a) => a.default)) throw new Error("Choose one default run action in Conductor before importing.");
        run = (actions.find((a) => a.default) ?? actions[0])?.command;
      }
      const start = commands(run);
      if (teardown.length > 1 || start.length > 1) throw new Error("Put multiple run or teardown commands in a repository script before importing.");
      recipe = Recipe.parse({ setup, scripts: { ...(teardown[0] ? { teardown: teardown[0] } : {}), ...(start[0] ? { run: start[0] } : {}) } });
    } catch (err) { error = err instanceof Error ? err.message : "Invalid imported configuration."; }
    const text = recipe ? JSON.stringify(recipe, null, 2) : source;
    const hash = createHash("sha256").update(JSON.stringify(["import-v1", path, source, text])).digest("hex");
    return { file: path, importedFrom, hash, text, recipe, error, approved: store.recipeApproved(project.id, hash) };
  }
  return null;
}

/** A lane runs the recipe in its own checkout, which agents can edit; the main checkout is the fallback. */
export async function laneRecipe(store: Store, project: Project, lane: Lane): Promise<RecipeView | null> {
  return await readRecipe(store, project, lane.worktree) ?? readRecipe(store, project, project.path);
}
