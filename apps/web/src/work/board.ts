import type { BoardLane } from "@contextlanes/protocol";
export const BOARD_COLUMNS = ["Working", "Needs you", "In review", "Merged", "Failed"] as const;
export type BoardColumn = typeof BOARD_COLUMNS[number];
export function boardColumn(card: Pick<BoardLane, "lane" | "mergedAt">, needsYou = false, now = Date.now()): BoardColumn | null {
  const state = card.lane.state;
  if (state === "archived") return null;
  if (state === "merged" || state === "cleaned") return card.mergedAt && Date.parse(card.mergedAt) >= now - 7 * 86_400_000 ? "Merged" : null;
  if (state === "failed") return "Failed";
  if (state === "in_review") return "In review";
  return state === "needs_you" || needsYou ? "Needs you" : "Working";
}
