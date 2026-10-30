#!/usr/bin/env node
/**
 * Builds a project's code map with CodeGraph, in its own process and inside the lane sandbox:
 * CodeGraph parses with WebAssembly grammars that can run out of memory on large trees, and the
 * index lives in the project folder, which lanes can write. Neither may take the daemon down.
 *
 *     codemap-worker.js <project root> <architecture JSON or "">
 *
 * Prints one CodeMap as JSON on stdout. Indexes from scratch the first time, then syncs changed files.
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ArchitectureConfig, assign, CodeMap, isTestFile, LAYER_ORDER, sourceRoots } from "@contextlanes/protocol";

process.env.CODEGRAPH_TELEMETRY = "0";
process.env.DO_NOT_TRACK = "1";
const require = createRequire(import.meta.url);
type CodeGraphApi = typeof import("@colbymchenry/codegraph");

const LINK_KINDS = ["imports", "calls", "references", "extends", "implements", "instantiates"] as const;
const LANGUAGE: Record<string, string> = { typescript: "TypeScript", tsx: "React", javascript: "JavaScript", jsx: "React", python: "Python", go: "Go", rust: "Rust", java: "Java", kotlin: "Kotlin", ruby: "Ruby", php: "PHP", csharp: "C#", swift: "Swift", vue: "Vue", svelte: "Svelte", c: "C", cpp: "C++", dart: "Dart", scala: "Scala" };

/** Keep the index out of git without touching a tracked file. */
async function excludeIndex(root: string): Promise<void> {
  const file = join(root, ".git", "info", "exclude");
  const current = await readFile(file, "utf8").catch(() => null);
  if (current === null && !(await readFile(join(root, ".git", "HEAD"), "utf8").catch(() => null))) return;
  if (current?.split("\n").some((l) => l.trim() === ".codegraph/")) return;
  await mkdir(join(root, ".git", "info"), { recursive: true });
  await appendFile(file, `${current && !current.endsWith("\n") ? "\n" : ""}# ContextLanes code map\n.codegraph/\n`);
}

async function main(): Promise<void> {
  const [root, arch] = process.argv.slice(2);
  if (!root) throw new Error("usage: codemap-worker.js <project root> [architecture JSON]");
  const layersConfig = arch ? ArchitectureConfig.parse(JSON.parse(arch)).layers : undefined;
  const { CodeGraph, setLogger, silentLogger } = require("@colbymchenry/codegraph") as CodeGraphApi;
  setLogger(silentLogger);
  await excludeIndex(root);
  const cg = CodeGraph.isInitialized(root) ? await CodeGraph.open(root) : await CodeGraph.init(root);
  try {
    if (cg.getIndexState() !== "complete") await cg.indexAll({});
    else await cg.sync({});
    const files = cg.getFiles().filter((f) => !f.generated);
    const paths = files.map((f) => f.path);
    const rules: CodeMap["rules"] = layersConfig ? { source: "recipe", roots: [], layers: layersConfig } : { source: "inferred", roots: sourceRoots(paths) };
    // A package with many files reads better as its folders: split those with more than 25 code files.
    const sizes = new Map<string, number>();
    for (const f of files) { const a = assign(f.path, rules, f.language); if (a) sizes.set(a.module, (sizes.get(a.module) ?? 0) + 1); }
    rules.split = [...sizes].filter(([, n]) => n > 25).map(([m]) => m);
    const lines = new Map(cg.getFileNodes(paths).map((n) => [n.filePath, n.endLine ?? 0]));
    const assignments: { filePath: string; module: string }[] = [];
    const modules = new Map<string, { layer: string; files: number; lines: number; tests: number; languages: Map<string, number> }>();
    for (const f of files) {
      const a = assign(f.path, rules, f.language);
      if (!a) continue;
      assignments.push({ filePath: f.path, module: a.module });
      const m = modules.get(a.module) ?? { layer: a.layer, files: 0, lines: 0, tests: 0, languages: new Map() };
      m.files++; m.lines += lines.get(f.path) ?? 0; m.languages.set(f.language, (m.languages.get(f.language) ?? 0) + 1);
      modules.set(a.module, m);
    }
    // Too many modules to read: fold to the first level.
    if (modules.size > 40 && rules.source === "inferred") {
      const folded = new Map<string, string>();
      for (const a of assignments) { const top = a.module.split("/").length > 1 && !rules.roots.some((r) => r.endsWith("/*")) ? a.module.split("/")[0]! : a.module; folded.set(a.module, top); a.module = top; }
      const merged = new Map<string, { layer: string; files: number; lines: number; tests: number; languages: Map<string, number> }>();
      for (const [id, m] of modules) {
        const to = folded.get(id) ?? id; const t = merged.get(to) ?? { layer: m.layer, files: 0, lines: 0, tests: 0, languages: new Map() };
        t.files += m.files; t.lines += m.lines; for (const [l, n] of m.languages) t.languages.set(l, (t.languages.get(l) ?? 0) + n);
        merged.set(to, t);
      }
      modules.clear(); for (const [k, v] of merged) modules.set(k, v);
    }
    const moduleOf = new Map(assignments.map((a) => [a.filePath, a.module]));
    const agg = cg.getModuleAggregation(assignments, { kinds: LINK_KINDS, minConfidence: 0, topPairsPerLink: 3, pairKinds: ["calls", "references", "instantiates"] });
    const links = new Map<string, { source: string; target: string; count: number; kinds: Set<string> }>();
    for (const l of agg.links) {
      if (l.source === l.target) continue;
      const key = `${l.source}\0${l.target}`;
      const v = links.get(key) ?? { source: l.source, target: l.target, count: 0, kinds: new Set<string>() };
      v.count += l.count; v.kinds.add(l.kind); links.set(key, v);
    }
    // Tests: which test files reach into each module, grouped by their folder.
    const coveredBy: Record<string, Map<string, Set<string>>> = {};
    const testFiles = new Set(paths.filter(isTestFile));
    for (const pair of cg.getFileDependencyPairs(0)) {
      if (!testFiles.has(pair.source)) continue;
      const target = moduleOf.get(pair.target);
      if (!target) continue;
      const group = pair.source.split("/").slice(0, Math.max(1, pair.source.split("/").length - 1)).join("/");
      const byGroup = (coveredBy[target] ??= new Map());
      byGroup.set(group, (byGroup.get(group) ?? new Set()).add(pair.source));
    }
    for (const [target, groups] of Object.entries(coveredBy)) { const m = modules.get(target); if (m) m.tests = new Set([...groups.values()].flatMap((g) => [...g])).size; }
    // Main paths: routes traced from their handler's module along the busiest link toward the data layer.
    const rank = (id: string) => LAYER_ORDER.indexOf(modules.get(id)?.layer ?? "Logic");
    const out = new Map<string, { target: string; count: number }[]>();
    for (const l of links.values()) out.set(l.source, [...(out.get(l.source) ?? []), { target: l.target, count: l.count }].sort((a, b) => b.count - a.count));
    const manifest = cg.getRoutingManifest(200);
    const seenPaths = new Set<string>();
    const mainPaths: CodeMap["paths"] = [];
    for (const entry of manifest?.entries ?? []) {
      const start = [moduleOf.get(entry.routeFile), moduleOf.get(entry.handlerFile)].filter((m): m is string => !!m);
      if (!start.length) continue;
      const trail = [...new Set(start)];
      for (let i = 0; i < 5; i++) {
        const next = (out.get(trail.at(-1)!) ?? []).find((n) => !trail.includes(n.target) && rank(n.target) >= rank(trail.at(-1)!));
        if (!next) break;
        trail.push(next.target);
      }
      const key = trail.join(">");
      if (trail.length < 2 || seenPaths.has(key)) continue;
      seenPaths.add(key);
      mainPaths.push({ name: entry.url, modules: trail });
    }
    mainPaths.sort((a, b) => b.modules.length - a.modules.length);
    const layerNames = rules.source === "recipe" ? rules.layers!.map((l) => l.name) : LAYER_ORDER.filter((l) => [...modules.values()].some((m) => m.layer === l));
    const map: CodeMap = {
      syncedAt: new Date(cg.getLastIndexedAt() ?? Date.now()).toISOString(),
      files: files.length,
      layers: layerNames.map((name) => {
        const configured = rules.layers?.find((l) => l.name === name)?.tech;
        const counts = new Map<string, number>();
        for (const m of modules.values()) if (m.layer === name) for (const [l, n] of m.languages) counts.set(l, (counts.get(l) ?? 0) + n);
        const top = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
        return { name, tech: configured ?? (top ? LANGUAGE[top] ?? top : null) };
      }),
      modules: [...modules].map(([id, m]) => {
        const own = assignments.filter((a) => a.module === id).map((a) => a.filePath).sort();
        const hash = createHash("sha256").update(own.map((f) => `${f}:${files.find((x) => x.path === f)?.contentHash ?? ""}`).join("\n")).digest("hex").slice(0, 16);
        const symbols = cg.getNodesInFiles(own).filter((n) => n.isExported && ["function", "class", "method", "interface", "type_alias", "constant"].includes(n.kind))
          .slice(0, 12).map((n) => ({ name: n.name, kind: n.kind, file: n.filePath, signature: n.signature ? n.signature.split("\n")[0]!.slice(0, 160) : null }));
        const top = [...m.languages].sort((a, b) => b[1] - a[1])[0]?.[0];
        return { id, layer: m.layer, files: m.files, lines: m.lines, tests: m.tests, hash, symbols, paths: own.slice(0, 200), ...(top ? { tech: LANGUAGE[top] ?? top } : {}) };
      }).sort((a, b) => a.id.localeCompare(b.id)),
      links: [...links.values()].map((l) => ({ ...l, kinds: [...l.kinds] })).sort((a, b) => b.count - a.count),
      pairs: agg.pairs.filter((p) => p.source !== p.target).map(({ source, target, from, to, count }) => ({ source, target, from, to, count })),
      coveredBy: Object.fromEntries(Object.entries(coveredBy).map(([k, v]) => [k, [...v].map(([module, set]) => ({ module, files: set.size })).sort((a, b) => b.files - a.files)])),
      paths: mainPaths.slice(0, 5),
      rules,
    };
    process.stdout.write(JSON.stringify(CodeMap.parse(map)));
  } finally { cg.close(); }
}

main().catch((err) => { process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`); process.exit(1); });
