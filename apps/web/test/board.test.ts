import { expect, it } from "vitest";
import type { BoardLane, Lane } from "@contextlanes/protocol";
import { boardColumn } from "../src/work/board";
import { shellQuote, startLaneCommand } from "../src/components/StartLane";
const card = (state: Lane["state"], mergedAt: string | null = null) => ({ lane: { state } as Lane, mergedAt } satisfies Pick<BoardLane, "lane" | "mergedAt">);
it("groups lifecycle states and uses actual merge time for the seven-day window", () => {
  const now = Date.parse("2026-11-01T12:00:00Z");
  expect(boardColumn(card("working"))).toBe("Working");
  expect(boardColumn(card("working"), true)).toBe("Needs you");
  expect(boardColumn(card("in_review"), true)).toBe("In review");
  expect(boardColumn(card("pr_open"))).toBe("In review");
  expect(boardColumn(card("integration_pending"))).toBe("In review");
  expect(boardColumn(card("failed"), true)).toBe("Failed");
  expect(boardColumn(card("merged", "2026-10-26T12:00:00Z"), false, now)).toBe("Merged");
  expect(boardColumn(card("cleaned", "2026-10-20T12:00:00Z"), false, now)).toBeNull();
  expect(boardColumn(card("merged"), false, now)).toBeNull();
  expect(boardColumn(card("archived"))).toBeNull();
});
it("hands a suggested lane over as a command the shell cannot expand", () => {
  expect(startLaneCommand("shop")).toBe('contextlanes new shop "<task>"');
  expect(startLaneCommand("shop", "Fix Kyle's $HOME `bug`")).toBe("contextlanes new shop 'Fix Kyle'\\''s $HOME `bug`'");
  expect(shellQuote("plain")).toBe("'plain'");
});
