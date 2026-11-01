import { expect, it } from "vitest";
import { diffLines } from "../src/work/review";
it("attaches comments to actual old and new line numbers across hunks and files", () => {
  const text = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -8,2 +12,3 @@\n same\n-old\n+new\n+extra\n@@ -30 +40 @@\n-next\n+after\ndiff --git a/gone.ts b/gone.ts\n--- a/gone.ts\n+++ /dev/null\n@@ -2 +0,0 @@\n-gone';
  const rows = diffLines(text).filter(r => r.line !== null);
  expect(rows.map(({ file, line, side, text }) => [file, line, side, text])).toEqual([
    ["a.ts", 12, "new", " same"], ["a.ts", 9, "old", "-old"], ["a.ts", 13, "new", "+new"], ["a.ts", 14, "new", "+extra"], ["a.ts", 30, "old", "-next"], ["a.ts", 40, "new", "+after"], ["gone.ts", 2, "old", "-gone"],
  ]);
});
it("decodes Git's quoted UTF-8 paths for comments", () => {
  const row = diffLines('--- "a/caf\\303\\251.ts"\n+++ "b/caf\\303\\251.ts"\n@@ -1 +1 @@\n+new').at(-1);
  expect(row).toMatchObject({ file: "café.ts", line: 1, side: "new" });
});
