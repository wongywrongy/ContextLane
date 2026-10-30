import type { InboxItem, Lane, LaneState , ProjectMap } from "@contextlanes/protocol";

/** Text versions of the state glyphs, so the CLI keeps "meaning is never colour alone". */
const GLYPH: Record<LaneState, string> = {
  draft: "·", setting_up: "◌", working: "●", needs_you: "◆", in_review: "◆",
  merged: "✓", cleaned: "✓", failed: "■", paused: "‖", archived: "○",
};

const LABEL: Record<LaneState, string> = {
  draft: "draft", setting_up: "setting up", working: "working", needs_you: "needs you", in_review: "in review",
  merged: "merged", cleaned: "cleaned up", failed: "failed", paused: "paused", archived: "archived",
};

export function formatLanes(lanes: Lane[]): string {
  if (lanes.length === 0) return "No lanes. Start one with: contextlanes lane start <project> \"<task>\"";
  const rows = lanes.map((l) => [`[${l.id.slice(l.id.lastIndexOf("/") + 1)}]`, l.project, `${GLYPH[l.state]} ${LABEL[l.state]}`, l.agent, l.task]);
  return table(["LANE", "PROJECT", "STATE", "AGENT", "TASK"], rows);
}

export function formatInbox(items: InboxItem[]): string {
  if (items.length === 0) return "Nothing is waiting on you.";
  return table(["ID", "KIND", "WAITING", "TITLE"], items.map((i) => [i.id, i.kind, since(i.since), i.title]));
}

function since(iso: string, now = Date.now()): string {
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
}

export function table(head: string[], rows: string[][]): string {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!))).join("  ").trimEnd();
  return [line(head), ...rows.map(line)].join("\n");
}

/**
 * `contextlanes arch`: layers top to bottom, each module with what it uses, and where lanes are working.
 * Lane numbers in brackets; "*" marks a module two or more lanes are editing.
 */
export function formatArch(view: ProjectMap): string {
  if (!view.map) return view.error ?? "No code map yet.";
  const map = view.map;
  const lanesOn = new Map<string, string[]>();
  for (const o of view.lanes) for (const m of Object.keys(o.modules)) lanesOn.set(m, [...(lanesOn.get(m) ?? []), o.lane.split("/")[1]!]);
  const lines = [`${map.modules.length} modules · ${map.files} files · synced ${map.syncedAt}`];
  for (const layer of map.layers) {
    lines.push("", `${layer.name.toUpperCase()}${layer.tech ? ` (${layer.tech})` : ""}`);
    for (const m of map.modules.filter((x) => x.layer === layer.name)) {
      const on = lanesOn.get(m.id);
      const uses = map.links.filter((l) => l.source === m.id).map((l) => l.target);
      lines.push(`  ${on && on.length > 1 ? "*" : " "} ${m.id}  ${m.files} ${m.files === 1 ? "file" : "files"}${on ? `  [${on.join(" ")}]` : ""}${uses.length ? `\n      uses ${uses.join(", ")}` : ""}`);
    }
  }
  const created = view.lanes.flatMap((o) => o.created.map((c) => `${c} [${o.lane.split("/")[1]}]`));
  if (created.length) lines.push("", "NEW IN LANES", ...created.map((c) => `    ${c}`));
  if (map.paths.length) lines.push("", "MAIN PATHS", ...map.paths.map((p) => `    ${p.name}: ${p.modules.join(" → ")}`));
  return lines.join("\n");
}

/** Mermaid flowchart: one subgraph per layer, lanes' modules styled. Paste into any Mermaid renderer. */
export function formatMermaid(view: ProjectMap): string {
  if (!view.map) return `%% ${view.error ?? "No code map yet."}`;
  const map = view.map;
  const id = (m: string) => `m_${m.replace(/[^A-Za-z0-9]/g, "_")}`;
  const touched = new Map<string, number>();
  for (const o of view.lanes) for (const m of Object.keys(o.modules)) touched.set(m, (touched.get(m) ?? 0) + 1);
  const out = ["flowchart LR"];
  for (const layer of map.layers) {
    out.push(`  subgraph ${id(`layer ${layer.name}`)}["${layer.name}"]`);
    for (const m of map.modules.filter((x) => x.layer === layer.name)) out.push(`    ${id(m.id)}["${m.id}"]`);
    out.push("  end");
  }
  for (const l of map.links) out.push(`  ${id(l.source)} --> ${id(l.target)}`);
  out.push("  classDef lane stroke:#4b4bd6,stroke-width:2px", "  classDef two stroke:#d98a00,stroke-width:2px,stroke-dasharray:4 3");
  for (const [m, n] of touched) if (map.modules.some((x) => x.id === m)) out.push(`  class ${id(m)} ${n > 1 ? "two" : "lane"}`);
  return out.join("\n");
}
