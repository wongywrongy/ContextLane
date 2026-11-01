import { expect, it, vi } from "vitest";
import type { BoardLane, Lane } from "@contextlanes/protocol";
import { boardColumn, boardDrop } from "../src/work/board";
import type { postJson } from "../src/api";
const card = (state: Lane["state"], mergedAt: string | null = null) => ({ lane: { state } as Lane, mergedAt } satisfies Pick<BoardLane, "lane" | "mergedAt">);
it("groups lifecycle states and uses actual merge time for the seven-day window", () => {
  const now = Date.parse("2026-11-01T12:00:00Z");
  expect(boardColumn(card("working"))).toBe("Working");
  expect(boardColumn(card("working"), true)).toBe("Needs you");
  expect(boardColumn(card("in_review"), true)).toBe("In review");
  expect(boardColumn(card("failed"), true)).toBe("Failed");
  expect(boardColumn(card("merged", "2026-10-26T12:00:00Z"), false, now)).toBe("Merged");
  expect(boardColumn(card("cleaned", "2026-10-20T12:00:00Z"), false, now)).toBeNull();
  expect(boardColumn(card("merged"), false, now)).toBeNull();
  expect(boardColumn(card("archived"))).toBeNull();
});
it("uses the checkpoint and archive APIs for drag/menu actions, and rejects other moves", async () => {
  const lane = { id: "shop/01", state: "working", task: "Invoice API" } as Lane;
  const post = vi.fn(async () => ({ asked: true })) as typeof postJson;
  expect(await boardDrop(lane, "In review", post)).toContain("asked to commit");
  expect(post).toHaveBeenLastCalledWith("/api/lanes/shop/01/checkpoint", { summary: "Invoice API" });
  await boardDrop({ ...lane, state: "failed" }, "Archive", post);
  expect(post).toHaveBeenLastCalledWith("/api/lanes/shop/01/archive", {});
  await boardDrop(lane, "Merged", post);
  expect(post).toHaveBeenCalledTimes(2);
});
