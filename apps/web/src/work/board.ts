import type { BoardLane, Lane } from "@contextlanes/protocol";
import { postJson } from "../api";
export const BOARD_COLUMNS = ["Working", "Needs you", "In review", "Merged", "Failed"] as const;
export type BoardColumn = typeof BOARD_COLUMNS[number];
export function boardColumn(card: Pick<BoardLane, "lane" | "mergedAt">, needsYou = false, now = Date.now()): BoardColumn | null {
  const state = card.lane.state;
  if (state === "archived") return null;
  if (state === "merged" || state === "cleaned") return card.mergedAt && Date.parse(card.mergedAt) >= now - 7 * 86_400_000 ? "Merged" : null;
  if (state === "failed") return "Failed";
  if (["in_review", "pr_open", "integration_pending"].includes(state)) return "In review";
  return state === "needs_you" || needsYou ? "Needs you" : "Working";
}
export async function boardDrop(lane: Lane, column: BoardColumn | "Archive", post: typeof postJson = postJson): Promise<string> {
  if (column === "In review" && lane.state === "working") {
    const response = await post<{ asked: boolean }>(`/api/lanes/${lane.id}/checkpoint`, { summary: lane.task });
    return response.asked ? "The agent was asked to commit and send a checkpoint." : "Checks started. The checkpoint will appear in Review.";
  }
  if (column === "Archive" && lane.state === "failed") { await post(`/api/lanes/${lane.id}/archive`, {}); return "Failed lane archived; checkout and history kept."; }
  return "That move has no action. Use the lane's own controls.";
}
