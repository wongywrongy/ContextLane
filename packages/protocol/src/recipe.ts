import { z } from "zod";
import type { RunFacts } from "./resources.js";

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

const EnvName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);
/**
 * A scratch database per lane. Postgres copies a template database through the daemon's admin login
 * (from config, never from the recipe) and gives services a non-admin login. SQLite copies a file
 * from the main checkout. The value reaches setup steps and services in `env`.
 */
export const RecipeDatabase = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("postgres"), template: z.string().regex(/^[a-z_][a-z0-9_]{0,39}$/, "a lowercase database name"), env: EnvName.default("DATABASE_URL") }),
  z.strictObject({ kind: z.literal("sqlite"), file: RelativePath, env: EnvName.default("DATABASE_PATH") }),
]);
export type RecipeDatabase = z.infer<typeof RecipeDatabase>;
export type LaneDatabase = { kind: "postgres" | "sqlite"; name: string; template: string | null };

export const Recipe = z.strictObject({
  /** Runs once per lane, after ignored files and dependencies arrive. */
  setup: z.array(RecipeStep).max(20).default([]),
  /** Dependency folders taken from the main checkout, such as node_modules. */
  cache: z.array(RelativePath).max(20).default([]),
  services: z.array(RecipeService).max(10).default([]).refine((s) => new Set(s.map((x) => x.name)).size === s.length, "service names must be unique"),
  checks: z.array(RecipeStep).max(20).default([]),
  database: RecipeDatabase.optional(),
  /** Pages for before and after screenshots. */
  screenshots: z.array(z.string().startsWith("/")).max(5).default(["/"]),
});
export type Recipe = z.infer<typeof Recipe>;

export const ServiceState = z.enum(["starting", "healthy", "failed", "stopped"]);
export type ServiceState = z.infer<typeof ServiceState>;

export const ServiceStatus = z.object({
  name: z.string(),
  unit: z.string(),
  port: z.number().int(),
  url: z.string().nullable(),
  state: ServiceState,
  detail: z.string().nullable(),
  /** Newest last, one per health probe. */
  probes: z.array(z.boolean()),
  ms: z.number().nullable(),
  lastFailure: z.string().nullable(),
  healthPath: z.string(),
  healthStatus: z.number().int(),
});
export type ServiceStatus = z.infer<typeof ServiceStatus>;

/** A lane's environment as recorded: what setup did and how each service is doing. */
export const EnvironmentView = z.object({
  lane: z.string(),
  recipeHash: z.string(),
  services: z.array(ServiceStatus),
  setup: z.object({ ignored: z.array(z.string()), cache: z.enum(["none", "linked", "copied"]), seconds: z.number(), steps: z.number().int(), disk: z.number().nullable(),
    database: z.object({ kind: z.enum(["postgres", "sqlite"]), name: z.string(), template: z.string().nullable() }).nullable().optional() }).nullable(),
  startedAt: z.string().nullable(),
  error: z.string().nullable(),
});
export type EnvironmentView = z.infer<typeof EnvironmentView>;

/** The Run page: the project's recipe, and each open lane's own recipe and environment. */
export type LaneEnvironment = { lane: string; recipe: RecipeView | null; environment: EnvironmentView | null };
export type ProjectEnvironments = { cleanup: { lane: string; unpushed: number | null; disk: number | null }[]; previews: "serve" | "services" | "caddy"; domain: string | null; recipe: RecipeView | null; lanes: LaneEnvironment[]; facts: RunFacts };

export const StartEnvRequest = z.object({ services: z.array(z.string()).optional() });
export const LogsQuery = z.object({ service: z.string().min(1), lines: z.coerce.number().int().positive().max(500).default(100) });
export type LogLine = { at: string; text: string };

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
