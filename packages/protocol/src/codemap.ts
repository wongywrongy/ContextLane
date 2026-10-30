import { z } from "zod";

/** `.contextlanes.json` `architecture`: the owner's own layers. Globs use * (one folder level) and ** (any depth). */
export const ArchitectureConfig = z.strictObject({
  layers: z.array(z.strictObject({ name: z.string().min(1).max(40), tech: z.string().max(60).optional(), paths: z.array(z.string().min(1).max(200)).min(1).max(40) })).min(1).max(8),
});
export type ArchitectureConfig = z.infer<typeof ArchitectureConfig>;

export const CodeModule = z.object({ id: z.string(), layer: z.string(), files: z.number().int(), lines: z.number().int(), tests: z.number().int() });
export type CodeModule = z.infer<typeof CodeModule>;
export const CodeLink = z.object({ source: z.string(), target: z.string(), count: z.number().int(), kinds: z.array(z.string()) });
/** The busiest symbol pairs behind a link: "solver/model.py → to_solver_input()". */
export const CodePair = z.object({ source: z.string(), target: z.string(), from: z.string(), to: z.string(), count: z.number().int() });
export const MainPath = z.object({ name: z.string(), modules: z.array(z.string()) });
export const CodeMap = z.object({
  syncedAt: z.string(),
  files: z.number().int(),
  layers: z.array(z.object({ name: z.string(), tech: z.string().nullable() })),
  modules: z.array(CodeModule),
  links: z.array(CodeLink),
  pairs: z.array(CodePair),
  /** Test files that import each module, by test module. */
  coveredBy: z.record(z.string(), z.array(z.object({ module: z.string(), files: z.number().int() }))),
  paths: z.array(MainPath),
  /** How files were assigned, so a lane's changed files land on the same modules. */
  rules: z.object({ source: z.enum(["recipe", "inferred"]), roots: z.array(z.string()), layers: ArchitectureConfig.shape.layers.optional(),
    /** Large packages split by their first folder ("apps/daemon/http"). */
    split: z.array(z.string()).optional() }),
});
export type CodeMap = z.infer<typeof CodeMap>;

/** A lane on the map: the modules it changed, modules it created, and the files behind each. */
export type LaneOverlay = { lane: string; modules: Record<string, string[]>; created: string[] };
export type ProjectMap = { map: CodeMap | null; error: string | null; lanes: LaneOverlay[] };

const TEST = /(^|\/)(tests?|__tests__|spec|e2e)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py)$|(^|\/)test_[^/]*\.py$/;
const NOT_CODE = /\.(json|ya?ml|toml|md|txt|lock|css|scss|html|svg|png|jpe?g|webp|gif|ico|xml|properties)$/;
export const isTestFile = (path: string) => TEST.test(path);

export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") { re += ".*"; i++; if (glob[i + 1] === "/") i++; }
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}(/.*)?$`);
}

const LAYER_WORDS: [string, RegExp][] = [
  ["Web", /(^|\/)(web|ui|frontend|client|pages|components|views|public|static|templates|styles|site)(\/|$)/],
  ["API", /(^|\/)(api|routes?|server|http|controllers?|handlers?|endpoints?|graphql|rpc|cli|daemon|commands?)(\/|$)/],
  ["Data", /(^|\/)(models?|db|database|data|migrations?|schemas?|store|storage|repositor(y|ies)|entities|prisma|sql|orm)(\/|$|\.)/],
];
export const LAYER_ORDER = ["Web", "API", "Logic", "Data"];

/** Monorepo package folders, else common source roots stripped before naming modules. */
export function sourceRoots(paths: string[]): string[] {
  const tops = new Map<string, Set<string>>();
  for (const p of paths) { const [a, b] = p.split("/"); if (b && ["packages", "apps", "services", "libs", "crates", "modules"].includes(a!)) tops.set(a!, (tops.get(a!) ?? new Set()).add(b)); }
  const mono = [...tops].filter(([, s]) => s.size >= 1).reduce((n, [, s]) => n + s.size, 0) >= 2;
  return mono ? [...tops.keys()].map((t) => `${t}/*`) : ["src", "lib", "app"].filter((r) => paths.some((p) => p.startsWith(`${r}/`)));
}

/**
 * Which module and layer a file belongs to, or null for tests, config and docs.
 * Inferred modules: a monorepo package, else the first two path levels under the source root,
 * where a file at the second level is its own module ("models/tournament.py").
 */
export function assign(path: string, rules: CodeMap["rules"], language?: string): { module: string; layer: string } | null {
  const a = assignBase(path, rules, language);
  if (!a || !rules.split?.includes(a.module)) return a;
  const rest = path.slice(a.module.length + 1).replace(/^src\//, "").split("/");
  if (rest.length < 2) return a;
  const module = `${a.module}/${rest[0]}`;
  return { module, layer: rules.source === "recipe" ? a.layer : layerOf(module, path) };
}

function assignBase(path: string, rules: CodeMap["rules"], language?: string): { module: string; layer: string } | null {
  if (TEST.test(path) || NOT_CODE.test(path) || ["yaml", "xml", "properties", "unknown"].includes(language ?? "")) return null;
  if (rules.source === "recipe" && rules.layers) {
    for (const layer of rules.layers) for (const glob of layer.paths) {
      const re = globToRegExp(glob);
      if (!re.test(path)) continue;
      const fixed = glob.split("/").filter((s) => !s.includes("*")).length;
      const parts = path.split("/");
      const module = parts.slice(0, Math.min(parts.length, Math.max(fixed + 1, 2))).join("/");
      return { module, layer: layer.name };
    }
    return null;
  }
  for (const root of rules.roots) {
    if (root.endsWith("/*")) {
      const base = root.slice(0, -2);
      if (path.startsWith(`${base}/`)) { const module = path.split("/").slice(0, 2).join("/"); return { module, layer: layerOf(module, path) }; }
    } else if (path.startsWith(`${root}/`)) {
      const rest = path.slice(root.length + 1).split("/");
      const module = rest.length <= 1 ? rest.join("/") : rest.slice(0, 2).join("/");
      return { module, layer: layerOf(module, path) };
    }
  }
  if (rules.roots.some((r) => r.endsWith("/*"))) return null;
  const parts = path.split("/");
  const module = parts.length <= 1 ? parts[0]! : parts.slice(0, 2).join("/");
  return { module, layer: layerOf(module, path) };
}

function layerOf(module: string, path: string): string {
  if (/\.(tsx|jsx|vue|svelte|astro)$/.test(path)) return "Web";
  // The module's own name decides before its parents: apps/daemon/db is data, not API.
  // A file standing as its own module ("solver/model.py") takes its folder's layer, not its file name's.
  const parts = module.split("/");
  const named = /\.[a-z0-9]+$/i.test(parts.at(-1)!) ? parts.slice(0, -1) : parts;
  const own = named.at(-1) ?? "";
  for (const [name, re] of LAYER_WORDS) if (re.test(own)) return name;
  for (const [name, re] of LAYER_WORDS) if (re.test(named.join("/"))) return name;
  return "Logic";
}
