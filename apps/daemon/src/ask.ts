import type { AskAnswer, ProjectId } from "@contextlanes/protocol";
import type { Briefs } from "./briefs.js";
import type { CodeMaps } from "./codemap.js";
import type { Store } from "./db/store.js";
import { NotFound, Refused } from "./lanes/manager.js";
import type { LocalModels } from "./localmodels.js";

const OPEN = ["setting_up", "working", "needs_you", "in_review", "failed", "paused"];

/**
 * ⌘K Ask: answers a question about a project from what ContextLanes already knows — project notes,
 * the code map, written briefs and the open lanes — with the local model, citing each source. Read
 * only. A citation to a source it was not given is removed, so every source shown is real.
 */
export class Ask {
  constructor(private deps: { store: Store; codemaps: CodeMaps; briefs: Briefs; models: LocalModels }) {}

  async ask(project: ProjectId, question: string): Promise<AskAnswer> {
    const { store, codemaps, briefs, models } = this.deps;
    const p = store.getProject(project);
    if (!p) throw new NotFound("no such project");
    const model = await models.forJob("ask");
    if (!model) throw new Refused("Add a local model for Ask under Models to ask questions.");
    const sources = new Map<string, { kind: AskAnswer["sources"][number]["kind"]; label: string; text: string }>();
    const notes = await briefs.notes(project);
    if (notes.trim()) sources.set("notes", { kind: "notes", label: "Project notes", text: notes.slice(0, 3000) });
    const { map } = await codemaps.map(project).catch(() => ({ map: null }));
    if (map) {
      sources.set("map", { kind: "map", label: "Code map", text: [
        `Layers: ${map.layers.map((l) => `${l.name}${l.tech ? ` (${l.tech})` : ""}`).join(", ")}`,
        ...map.modules.map((m) => `${m.id} [${m.layer}, ${m.files} files] uses: ${map.links.filter((l) => l.source === m.id).map((l) => l.target).join(", ") || "nothing"}`),
        ...map.paths.map((x) => `Main path ${x.name}: ${x.modules.join(" -> ")}`)].join("\n").slice(0, 6000) });
      const words = question.toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length > 2);
      const ranked = [...map.modules].sort((a, b) => words.filter((w) => b.id.toLowerCase().includes(w)).length - words.filter((w) => a.id.toLowerCase().includes(w)).length);
      let budget = 6000;
      for (const m of ranked.slice(0, 12)) {
        const b = await briefs.get(project, { module: m.id }).catch(() => null);
        if (!b?.text || budget <= 0) continue;
        sources.set(`module:${m.id}`, { kind: "brief", label: m.id, text: b.text });
        budget -= b.text.length;
      }
    }
    for (const lane of store.listLanes(project).filter((l) => OPEN.includes(l.state))) sources.set(`lane:${lane.id}`, { kind: "lane", label: `${lane.id} · ${lane.task}`, text: `Lane ${lane.id}: "${lane.task}", ${lane.state}, branch ${lane.branch}` });
    if (!sources.size) throw new Refused("There is nothing about this project to answer from yet: no notes, no code map and no lanes.");
    const context = [...sources].map(([id, s]) => `[${id}]\n${s.text}`).join("\n\n");
    const answer = await models.chat(model, [
      { role: "system", content: "Answer the owner's question about their project using only the sources given. Be brief: at most five sentences. After each claim put the id of the source it came from in square brackets, like [module:api/routes] or [notes]. If the sources do not say, answer that they do not say." },
      { role: "user", content: `${context}\n\nQuestion: ${question}` },
    ], { maxTokens: 600 });
    const cited = new Set<string>();
    const text = answer.text.replace(/\[([^\]]+)\]/g, (whole, id: string) => sources.has(id.trim()) ? (cited.add(id.trim()), whole) : "").replace(/ +([.,])/g, "$1").trim();
    return { answer: text, model: answer.model, sources: [...cited].map((id) => ({ id, kind: sources.get(id)!.kind, label: sources.get(id)!.label })) };
  }
}
