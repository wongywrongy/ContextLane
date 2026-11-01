export const PANE_KINDS = ["terminal", "diff", "preview", "progress", "steps"] as const;
export type PaneKind = typeof PANE_KINDS[number];
export type PaneLeaf = { id: string; kind: PaneKind };
export type PaneLayout = PaneLeaf | { direction: "row" | "column"; first: PaneLayout; second: PaneLayout };
export function paneLeaves(layout: PaneLayout): PaneLeaf[] { return "id" in layout ? [layout] : [...paneLeaves(layout.first), ...paneLeaves(layout.second)]; }
export function parseLayout(value: unknown, fallback: PaneKind): PaneLayout {
  const ids = new Set<string>();
  const read = (v: unknown, depth: number): PaneLayout => {
    if (!v || typeof v !== "object" || depth > 4) throw new Error("Invalid layout");
    const node = v as Record<string, unknown>;
    if (typeof node.id === "string" && node.id.length > 0 && node.id.length <= 64 && PANE_KINDS.includes(node.kind as PaneKind) && !ids.has(node.id)) { ids.add(node.id); return { id: node.id, kind: node.kind as PaneKind }; }
    if (node.direction === "row" || node.direction === "column") return { direction: node.direction, first: read(node.first, depth + 1), second: read(node.second, depth + 1) };
    throw new Error("Invalid layout");
  };
  try { const layout = read(value, 0), leaves = paneLeaves(layout), kinds = leaves.filter(p => p.kind !== "terminal").map(p => p.kind); return leaves.length <= 4 && new Set(kinds).size === kinds.length ? layout : { id: "main", kind: fallback }; } catch { return { id: "main", kind: fallback }; }
}
export function replacePane(layout: PaneLayout, id: string, next: PaneLayout | null): PaneLayout | null {
  if ("id" in layout) return layout.id === id ? next : layout;
  const first = replacePane(layout.first, id, next), second = replacePane(layout.second, id, next);
  return first && second ? { ...layout, first, second } : first ?? second;
}
