import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { Recipe, RECIPE_FILE, type Lane, type Project, type RecipeView } from "@contextlanes/protocol";
import type { Store } from "./db/store.js";

const MAX_BYTES = 64 * 1024;

/** The hash covers the file's exact bytes, so any edit, even whitespace, needs approval again. */
export async function readRecipe(store: Store, project: Project, dir: string): Promise<RecipeView | null> {
  const file = await open(join(dir, RECIPE_FILE)).catch(() => null);
  if (!file) return null;
  try {
    const bytes = (await file.read(Buffer.alloc(MAX_BYTES + 1), 0, MAX_BYTES + 1, 0));
    const data = bytes.buffer.subarray(0, bytes.bytesRead);
    const hash = createHash("sha256").update(data).digest("hex");
    const view = { file: RECIPE_FILE, hash, text: data.subarray(0, MAX_BYTES).toString("utf8"), approved: store.recipeApproved(project.id, hash) };
    if (data.length > MAX_BYTES) return { ...view, recipe: null, error: "The recipe is larger than 64 KB." };
    try { return { ...view, recipe: Recipe.parse(JSON.parse(view.text)), error: null }; }
    catch (err) { return { ...view, recipe: null, error: err instanceof SyntaxError ? `Not valid JSON: ${err.message}` : "The recipe does not match the schema; check its keys and values." }; }
  } finally { await file.close(); }
}

/** A lane runs the recipe in its own checkout, which agents can edit; the main checkout is the fallback. */
export async function laneRecipe(store: Store, project: Project, lane: Lane): Promise<RecipeView | null> {
  return await readRecipe(store, project, lane.worktree) ?? readRecipe(store, project, project.path);
}
