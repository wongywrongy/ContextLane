import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { areaOf, LAYER_ORDER, type CodeMap, type ProjectId, type TidyChange, type TidyGrouping, type TidyView } from "@contextlanes/protocol";
import type { Config } from "./config.js";
import { NotFound, Refused } from "./lanes/manager.js";
import { jsonAnswer, type LocalModels } from "./localmodels.js";

type Saved = { proposal: TidyGrouping | null; approved: TidyGrouping | null };
const Output = z.object({
  areas: z.array(z.object({ name: z.string().trim().min(1).max(40), modules: z.array(z.string()) })).min(1).max(16),
  layers: z.record(z.string(), z.string()).default({}),
  notes: z.array(z.string().max(200)).max(5).default([]),
});

/**
 * Tidy (Architecture): the local model reads the module list CodeGraph found (names, layers, languages,
 * exported names, what each uses) and proposes named areas and corrected layers. Nothing changes until
 * the owner approves it; then the map shows the approved grouping on every build. Module ids, which
 * lanes and briefs are keyed on, never change.
 */
export class Tidy {
  private running = new Set<ProjectId>();
  constructor(private deps: { config: Config; models: LocalModels; raw: (project: ProjectId) => Promise<CodeMap | null>; changed: (project: ProjectId) => void }) {}
  private file(project: ProjectId) { return join(this.deps.config.paths.data, "tidy", `${project}.json`); }
  async saved(project: ProjectId): Promise<Saved> { return readFile(this.file(project), "utf8").then((t) => JSON.parse(t) as Saved, () => ({ proposal: null, approved: null })); }
  private async save(project: ProjectId, s: Saved) {
    await mkdir(join(this.deps.config.paths.data, "tidy"), { recursive: true, mode: 0o700 });
    await writeFile(`${this.file(project)}.tmp`, JSON.stringify(s), { mode: 0o600 }); await rename(`${this.file(project)}.tmp`, this.file(project));
  }

  /** The approved grouping laid over a fresh map: modules it names get its area and layer. */
  static apply(map: CodeMap, approved: TidyGrouping | null): CodeMap {
    if (!approved) return map;
    const ids = new Set(map.modules.map((m) => m.id));
    const modules = map.modules.map((m) => approved.layers[m.id] ? { ...m, layer: approved.layers[m.id]! } : m);
    const present = LAYER_ORDER.filter((l) => modules.some((m) => m.layer === l));
    const layers = present.map((name) => map.layers.find((l) => l.name === name) ?? { name, tech: null });
    return { ...map, modules, layers, areas: Object.fromEntries(Object.entries(approved.areas).filter(([m]) => ids.has(m))) };
  }

  async view(project: ProjectId): Promise<TidyView> {
    const s = await this.saved(project);
    const map = s.proposal ? await this.deps.raw(project) : null;
    const current = map ? Tidy.apply(map, s.approved) : null;
    const changes: TidyChange[] = s.proposal && current ? current.modules.flatMap((m) => {
      const from = { area: areaOf(m.id, current), layer: m.layer };
      const to = { area: s.proposal!.areas[m.id] ?? from.area, layer: s.proposal!.layers[m.id] ?? map!.modules.find((x) => x.id === m.id)!.layer };
      return from.area === to.area && from.layer === to.layer ? [] : [{ module: m.id, from, to }];
    }) : [];
    return {
      proposal: s.proposal ? { ...s.proposal, changes, areaNames: [...new Set(Object.values(s.proposal.areas))] } : null,
      approved: s.approved ? { at: s.approved.at, model: s.approved.model, areas: new Set(Object.values(s.approved.areas)).size } : null,
      canRun: !!this.deps.models.pick("tidy"), running: this.running.has(project),
    };
  }

  async propose(project: ProjectId): Promise<TidyView> {
    const map = await this.deps.raw(project);
    if (!map) throw new NotFound("There is no code map for this project yet.");
    const model = await this.deps.models.forJob("tidy");
    if (!model) throw new Refused("Add a local model for tidying under Models first.");
    if (this.running.has(project)) throw new Refused("A tidy is already running for this project.");
    this.running.add(project);
    try {
      const uses = (id: string) => map.links.filter((l) => l.source === id).slice(0, 4).map((l) => l.target);
      const facts = map.modules.map((m) => ({ id: m.id, layer: m.layer, files: m.files, language: m.tech ?? null, exports: (m.symbols ?? []).slice(0, 6).map((x) => `${x.kind} ${x.name}`), uses: uses(m.id) }));
      const answer = await this.deps.models.chatAny("tidy", model, [
        { role: "system", content: `You organise a code repository's modules for an architecture diagram. You get every module CodeGraph found, with its current layer (guessed from folder names), language, exported names and the modules it uses. Reply with JSON only:
{"areas":[{"name":"short plain name, e.g. Console app","modules":["module id"]}],"layers":{"module id":"${LAYER_ORDER.join("|")}"},"notes":["one sentence on anything that looks misplaced"]}
Rules: 3 to 12 areas, each module in exactly one area, group by what the code is for (an app, a service, a shared package), not by file type. Layers: Web is UI code, API is request handlers and routes, Logic is domain code and helpers, Data is storage, models and database code. Only list a module under "layers" when its current layer is wrong. Use only module ids you were given.` },
        { role: "user", content: JSON.stringify(facts) },
      ], { json: true, maxTokens: 3000 });
      const raw = Output.safeParse(jsonAnswer(answer.text));
      if (!raw.success) throw new Refused(`${model.name} did not return a usable grouping. Try again.`, 503);
      // Only real modules, each in one area; layers only from the known set. Anything left keeps its folder area.
      const ids = new Set(map.modules.map((m) => m.id));
      const areas: Record<string, string> = {};
      for (const a of raw.data.areas) for (const m of a.modules) if (ids.has(m) && !areas[m]) areas[m] = a.name;
      for (const m of map.modules) areas[m.id] ??= areaOf(m.id, map);
      const layers = Object.fromEntries(Object.entries(raw.data.layers).filter(([m, l]) => ids.has(m) && LAYER_ORDER.includes(l) && map.modules.find((x) => x.id === m)!.layer !== l));
      const s = await this.saved(project);
      await this.save(project, { ...s, proposal: { areas, layers, notes: raw.data.notes, model: answer.model, at: new Date().toISOString() } });
    } finally { this.running.delete(project); }
    return this.view(project);
  }

  async approve(project: ProjectId): Promise<TidyView> {
    const s = await this.saved(project);
    if (!s.proposal) throw new Refused("There is no proposed grouping to approve.");
    await this.save(project, { proposal: null, approved: s.proposal });
    this.deps.changed(project);
    return this.view(project);
  }
  async discard(project: ProjectId): Promise<TidyView> { const s = await this.saved(project); await this.save(project, { ...s, proposal: null }); return this.view(project); }
  /** Back to folder-based areas and layers. */
  async reset(project: ProjectId): Promise<TidyView> { await rm(this.file(project), { force: true }); this.deps.changed(project); return this.view(project); }
}
