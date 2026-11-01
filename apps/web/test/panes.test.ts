import { expect, it } from "vitest";
import { parseLayout, replacePane, paneLeaves, type PaneLayout } from "../src/work/panes";
const initial: PaneLayout = { id: "main", kind: "terminal" };
it("splits one selected pane and collapses its divider when closed", () => {
  const layout = replacePane(initial, "main", { direction: "row", first: initial, second: { id: "diff", kind: "diff" } })!;
  expect(paneLeaves(layout).map(p => p.kind)).toEqual(["terminal", "diff"]);
  const down = replacePane(layout, "diff", { direction: "column", first: { id: "diff", kind: "diff" }, second: { id: "preview", kind: "preview" } })!;
  expect(paneLeaves(parseLayout(JSON.parse(JSON.stringify(down)), "terminal"))).toHaveLength(3);
  expect(replacePane(layout, "diff", null)).toEqual(initial);
});
it("rejects malformed, duplicate and oversized stored presets", () => {
  expect(parseLayout({ id: "main", kind: "unknown" }, "terminal")).toEqual(initial);
  expect(parseLayout({ direction: "row", first: initial, second: initial }, "terminal")).toEqual(initial);
  const tooMany: PaneLayout = { direction: "row", first: { direction: "column", first: initial, second: { id: "a", kind: "terminal" } }, second: { direction: "column", first: { id: "b", kind: "diff" }, second: { direction: "row", first: { id: "c", kind: "steps" }, second: { id: "d", kind: "preview" } } } };
  expect(parseLayout(tooMany, "terminal")).toEqual(initial);
});
