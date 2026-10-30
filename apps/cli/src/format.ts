import type { InboxItem, Lane, LaneState } from "@contextlanes/protocol";

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
