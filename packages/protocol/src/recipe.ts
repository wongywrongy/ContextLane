import { z } from "zod";

/**
 * .contextlanes.json: how to run a project in a lane. Commands are argument arrays, never shell
 * strings, and unknown keys are refused so a typo cannot silently drop a health check.
 */
export const RECIPE_FILE = ".contextlanes.json";
const Name = z.string().regex(/^[a-z][a-z0-9-]{0,30}$/, "lowercase letters, digits and dashes");
const Argv = z.array(z.string().min(1).max(4096)).min(1).max(100);
const RelativePath = z.string().min(1).max(512).refine((p) => !p.startsWith("/") && !p.split("/").includes(".."), "a path inside the repository");
const Timeout = (fallback: number) => z.number().int().positive().max(3600).default(fallback);

export const RecipeStep = z.strictObject({ name: z.string().min(1).max(100), command: Argv, timeoutSeconds: Timeout(600) });
export type RecipeStep = z.infer<typeof RecipeStep>;

export const RecipeService = z.strictObject({
  name: Name,
  command: Argv,
  /** The lane's free port arrives in this variable, and as $PORT inside command arguments. */
  port: z.strictObject({ env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).default("PORT") }).prefault({}),
  health: z.strictObject({ path: z.string().startsWith("/").default("/"), status: z.number().int().min(100).max(599).default(200), timeoutSeconds: Timeout(60) }).prefault({}),
  env: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string()).default({}),
});
export type RecipeService = z.infer<typeof RecipeService>;

export const Recipe = z.strictObject({
  /** Runs once per lane, after ignored files and dependencies arrive. */
  setup: z.array(RecipeStep).max(20).default([]),
  /** Dependency folders taken from the main checkout, such as node_modules. */
  cache: z.array(RelativePath).max(20).default([]),
  services: z.array(RecipeService).max(10).default([]).refine((s) => new Set(s.map((x) => x.name)).size === s.length, "service names must be unique"),
  checks: z.array(RecipeStep).max(20).default([]),
  /** Pages for before and after screenshots. */
  screenshots: z.array(z.string().startsWith("/")).max(5).default(["/"]),
});
export type Recipe = z.infer<typeof Recipe>;

export const RecipeHash = z.string().regex(/^[a-f0-9]{64}$/);
export const ApproveRecipeRequest = z.object({ hash: RecipeHash });

/** The recipe a project or lane would run, and whether the owner approved these exact bytes. */
export const RecipeView = z.object({
  file: z.string(),
  hash: RecipeHash,
  text: z.string(),
  approved: z.boolean(),
  recipe: Recipe.nullable(),
  error: z.string().nullable(),
});
export type RecipeView = z.infer<typeof RecipeView>;
