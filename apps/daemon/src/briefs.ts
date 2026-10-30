import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assign, estimateTokens, type CodeMap, type ModuleBrief, type ProjectId } from "@contextlanes/protocol";
import { readInside } from "./safefs.js";
import type { CodeMaps } from "./codemap.js";
import type { Config } from "./config.js";
import type { Store } from "./db/store.js";
import { NotFound, Refused } from "./lanes/manager.js";
import type { LocalModels } from "./localmodels.js";

type Saved = { module: string; hash: string; text: string; edited: boolean; model: string | null; writtenAt: string };
const MAX_HEAD = 60;

/**
 * Module briefs: a short note per module, written by the local model from CodeGraph's facts and the
 * opening lines of its files, cached against the module's content hash. An owner edit is kept until
 * the files change. Project notes: owner-written facts every new lane starts with.
 */
export class Briefs {
  private writing = new Map<string, Promise<void>>();
  constructor(private deps: { config: Config; store: Store; codemaps: CodeMaps; models: LocalModels }) {}

  private dir(project: ProjectId) { return join(this.deps.config.paths.data, "briefs", project); }
  private file(project: ProjectId, module: string) { return join(this.dir(project), `${createHash("sha256").update(module).digest("hex").slice(0, 24)}.json`); }
  private notesFile(project: ProjectId) { return join(this.deps.config.paths.data, "notes", `${project}.md`); }

  private async saved(project: ProjectId, module: string): Promise<Saved | null> {
    return readFile(this.file(project, module), "utf8").then((t) => JSON.parse(t) as Saved, () => null);
  }
  private async save(project: ProjectId, brief: Saved): Promise<void> {
    await mkdir(this.dir(project), { recursive: true, mode: 0o700 });
    const target = this.file(project, brief.module);
    await writeFile(`${target}.tmp`, JSON.stringify(brief), { mode: 0o600 });
    await rename(`${target}.tmp`, target);
  }

  /** CodeGraph's facts about a module, plain text: what it exports, what uses it, what it uses, its tests. */
  facts(map: CodeMap, module: string): string {
    const m = map.modules.find((x) => x.id === module)!;
    const usedBy = map.links.filter((l) => l.target === module).map((l) => { const p = map.pairs.filter((x) => x.source === l.source && x.target === module).sort((a, b) => b.count - a.count)[0]; return p ? `${l.source} (${p.to})` : l.source; });
    const uses = map.links.filter((l) => l.source === module).map((l) => l.target);
    const tests = map.coveredBy[module] ?? [];
    return [`Module ${module} · ${m.layer} layer · ${m.files} ${m.files === 1 ? "file" : "files"}${m.lines ? `, ${m.lines} lines` : ""}`,
      m.symbols?.length ? `Exports: ${m.symbols.map((s) => `${s.name}${s.signature?.startsWith("(") ? s.signature : ""} [${s.kind}, ${s.file}]`).join("; ")}` : "",
      usedBy.length ? `Used by: ${usedBy.join(", ")}` : "Used by: nothing else in the project",
      uses.length ? `Uses: ${uses.join(", ")}` : "",
      tests.length ? `Tests: ${tests.map((t) => `${t.module} (${t.files})`).join(", ")}` : "Tests: none import it"].filter(Boolean).join("\n");
  }

  private async module(project: ProjectId, query: { module?: string; path?: string }): Promise<{ map: CodeMap; module: CodeMap["modules"][number]; root: string }> {
    const p = this.deps.store.getProject(project);
    if (!p) throw new NotFound("no such project");
    const { map, error } = await this.deps.codemaps.map(project);
    if (!map) throw new Refused(error ?? "The code map is not ready yet.", 503);
    const id = query.module ?? (query.path ? assign(query.path.replace(/^\.?\//, ""), map.rules)?.module : undefined);
    const module = map.modules.find((m) => m.id === id);
    if (!module) throw new NotFound(`No module ${query.module ?? query.path} on the code map. Modules: ${map.modules.map((m) => m.id).slice(0, 40).join(", ")}`);
    return { map, module, root: p.path };
  }

  async get(project: ProjectId, query: { module?: string; path?: string }): Promise<ModuleBrief> {
    const { map, module, root } = await this.module(project, query);
    const saved = await this.saved(project, module.id);
    const size = (await Promise.all((module.paths ?? []).map((f) => stat(join(root, f)).then((s) => s.size, () => 0)))).reduce((a, b) => a + b, 0);
    const stale = !!saved && saved.hash !== module.hash;
    return { module: module.id, text: saved?.text ?? null, edited: saved?.edited ?? false, stale, model: saved?.model ?? null, writtenAt: saved?.writtenAt ?? null,
      tokens: saved ? estimateTokens(saved.text) : null, filesTokens: Math.ceil(size / 4), canWrite: !!this.deps.models.pick(), facts: this.facts(map, module.id) };
  }

  /** Writes (or rewrites) a brief with the local model. One write per module at a time. */
  async write(project: ProjectId, query: { module?: string; path?: string }): Promise<ModuleBrief> {
    const { map, module, root } = await this.module(project, query);
    const model = this.deps.models.pick();
    if (!model) throw new Refused("Add a local model under Models to write briefs.");
    const key = `${project}\0${module.id}`;
    let job = this.writing.get(key);
    if (!job) {
      job = (async () => {
        const heads = await Promise.all((module.paths ?? []).slice(0, 8).map(async (f) => {
          const text = (await readInside(root, f, 64_000).catch(() => null))?.text ?? "";
          return `--- ${f}\n${text.split("\n").slice(0, MAX_HEAD).join("\n").slice(0, 4000)}`;
        }));
        const result = await this.deps.models.chat(model, [
          { role: "system", content: "You write short module briefs for coding agents working in this repository. Plain text, no markdown headings, at most 120 words. Say what the module is for, its main entry points by name, rules or invariants a change must keep, and what breaks if they are ignored. Only state what the facts or the code show; do not guess." },
          { role: "user", content: `${this.facts(map, module.id)}\n\nOpening lines of its files:\n${heads.join("\n\n")}` },
        ], { maxTokens: 400 });
        if (!result.text) throw new Refused(`${model.name} returned an empty brief.`, 503);
        await this.save(project, { module: module.id, hash: module.hash ?? "", text: result.text, edited: false, model: result.model, writtenAt: new Date().toISOString() });
      })().finally(() => this.writing.delete(key));
      this.writing.set(key, job);
    }
    await job;
    return this.get(project, { module: module.id });
  }

  async edit(project: ProjectId, module: string, text: string): Promise<ModuleBrief> {
    const found = await this.module(project, { module });
    await this.save(project, { module, hash: found.module.hash ?? "", text, edited: true, model: null, writtenAt: new Date().toISOString() });
    return this.get(project, { module });
  }

  /**
   * get_brief for an agent: the brief when it is current, written now if a model is set up (up to a
   * minute), and CodeGraph's facts either way, so the tool always answers with something true.
   */
  async forAgent(project: ProjectId, query: { module?: string; path?: string }): Promise<string> {
    let brief = await this.get(project, query);
    if ((!brief.text || brief.stale && !brief.edited) && brief.canWrite) {
      brief = await Promise.race([this.write(project, { module: brief.module }), new Promise<ModuleBrief>((resolve) => setTimeout(() => resolve(brief), 60_000))]).catch(() => brief);
    }
    const note = brief.text ? (brief.stale ? `${brief.text}\n(Written before the module's files last changed; check anything that matters.)` : brief.text) : brief.canWrite ? "No brief yet; it is being written." : "No brief: no local model is set up.";
    return `${note}\n\n${brief.facts}`.slice(0, 6000);
  }

  async notes(project: ProjectId): Promise<string> { return readFile(this.notesFile(project), "utf8").catch(() => ""); }
  async saveNotes(project: ProjectId, text: string): Promise<void> {
    if (!this.deps.store.getProject(project)) throw new NotFound("no such project");
    await mkdir(join(this.deps.config.paths.data, "notes"), { recursive: true, mode: 0o700 });
    await writeFile(`${this.notesFile(project)}.tmp`, text, { mode: 0o600 });
    await rename(`${this.notesFile(project)}.tmp`, this.notesFile(project));
  }
}
