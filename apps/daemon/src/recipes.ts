import { createHash } from "node:crypto";
import { readBytesInside } from "./safefs.js";
import { parse as parseToml } from "smol-toml";
import { Recipe, RECIPE_FILE, type Lane, type Project, type RecipeView } from "@contextlanes/protocol";
import type { Store } from "./db/store.js";
// Used only inside functions: lanes/manager.ts imports this module through runtime.ts.
import { Refused } from "./lanes/manager.js";

export const MAX_BYTES = 64 * 1024;

/** Files a recipe is read from, in order: our own, then the ones imported as proposals. */
const IMPORTS = [[".superset/config.json", "Superset"], [".conductor/settings.toml", "Conductor"], ["conductor.json", "Conductor"]] as const;
export const RECIPE_FILES: readonly string[] = [RECIPE_FILE, ...IMPORTS.map(([path]) => path)];

/**
 * The first of RECIPE_FILES found in a folder, with at most MAX_BYTES + 1 of its bytes (one more than
 * allowed, so a file that is too large can be told apart). `kind` is "file" for a regular file; a
 * symbolic link or anything else is reported, not followed (the Docker runtime reads inside a lane).
 */
export type FoundFile = { file: string; kind: "file" | "link" | "other"; data: Buffer };
export type RecipeFiles = (files: readonly string[]) => Promise<FoundFile | null>;

/** On this machine: the first file that reads as a regular file inside the folder. */
export function hostFiles(dir: string): RecipeFiles {
  return async (files) => {
    for (const path of files) {
      // safefs: the checkout is agent-controlled, so a link out of it or a device is never opened.
      const file = await readBytesInside(dir, path, MAX_BYTES + 1);
      if (file) return { file: path, kind: "file", data: file.data };
    }
    return null;
  };
}

/** The hash covers the file's exact bytes, so any edit, even whitespace, needs approval again. */
export function recipeView(store: Store, project: Project, found: FoundFile | null): RecipeView | null {
  if (!found) return null;
  if (found.kind !== "file") {
    // Nothing to approve: the view only says why the file is not read.
    const hash = createHash("sha256").update(JSON.stringify(["not-a-file", found.file, found.kind])).digest("hex");
    return { file: found.file, hash, text: "", approved: false, recipe: null, error: `${found.file} is ${found.kind === "link" ? "a symbolic link" : "not a regular file"}; ContextLanes reads only a regular file there.` };
  }
  const imported = IMPORTS.find(([path]) => path === found.file);
  if (imported) return importView(store, project, imported[0], imported[1], found.data);
  const data = found.data;
  const hash = createHash("sha256").update(data).digest("hex");
  const view = { file: RECIPE_FILE, hash, text: data.subarray(0, MAX_BYTES).toString("utf8"), approved: store.recipeApproved(project.id, hash) };
  if (data.length > MAX_BYTES) return { ...view, recipe: null, error: "The recipe is larger than 64 KB." };
  try { return { ...view, recipe: Recipe.parse(JSON.parse(view.text)), error: null }; }
  catch (err) { return { ...view, recipe: null, error: err instanceof SyntaxError ? `Not valid JSON: ${err.message}` : "The recipe does not match the schema; check its keys and values." }; }
}

export async function readRecipe(store: Store, project: Project, dir: string): Promise<RecipeView | null> {
  return recipeView(store, project, await hostFiles(dir)(RECIPE_FILES));
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

function importView(store: Store, project: Project, path: string, importedFrom: "Superset" | "Conductor", bytes: Buffer): RecipeView {
  const source = bytes.toString("utf8");
  let recipe: Recipe | null = null, error: string | null = null;
  try {
    if (bytes.length > MAX_BYTES) throw new Error("The imported configuration is larger than 64 KB.");
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

/** A lane runs the recipe in its own checkout, which agents can edit; the main checkout is the fallback. */
export async function laneRecipe(store: Store, project: Project, lane: Lane): Promise<RecipeView | null> {
  return await readRecipe(store, project, lane.worktree) ?? readRecipe(store, project, project.path);
}

/**
 * Where recipes are read from. On the host, the folders themselves. In the Docker runtime the control
 * service cannot see them: a lane's from inside its container, the project's from a helper (docker/app.ts).
 */
export type RecipeReader = {
  project(project: Project): Promise<RecipeView | null>;
  lane(project: Project, lane: Lane): Promise<RecipeView | null>;
};

export const hostRecipes = (store: Store): RecipeReader => ({
  project: (project) => readRecipe(store, project, project.path),
  lane: (project, lane) => laneRecipe(store, project, lane),
});

/** What the recipe reader needs from the lanes and the helpers. */
export type AppFiles = {
  isDocker(lane: Pick<Lane, "id">): boolean;
  /** READ_SH in the lane, as its user, in its checkout. */
  readInLane(lane: Lane, files: readonly string[]): Promise<FoundFile | null>;
  /** READ_SH in a read-only helper that mounts only the project. */
  readInProject(project: Project, files: readonly string[]): Promise<FoundFile | null>;
};

/**
 * Recipes in the Docker runtime. A lane's own checkout first, then the project's main checkout, as on the
 * host. A lane made by the host runtime has no container to read in: refused, not read from a folder the
 * control service cannot see.
 */
export function dockerRecipes(store: Store, files: AppFiles): RecipeReader {
  return {
    project: async (p) => recipeView(store, p, await files.readInProject(p, RECIPE_FILES)),
    lane: async (p, lane) => {
      if (!files.isDocker(lane)) throw new Refused(`${lane.id} was made before ContextLanes ran in Docker and has no container, so its app cannot run here. Start a new lane.`, 409, "no_container");
      return recipeView(store, p, await files.readInLane(lane, RECIPE_FILES) ?? await files.readInProject(p, RECIPE_FILES));
    },
  };
}
