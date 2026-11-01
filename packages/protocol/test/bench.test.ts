import { expect, it } from "vitest";
import { benchTable, type BenchResult, type BenchRun } from "@contextlanes/protocol";
it("keeps missing benchmark totals unknown and distinguishes a measured zero", () => {
  const run = (baseline: boolean, tokens: number | null): BenchRun => ({ lane: null, baseline, tokens, minutes: null, passed: null, state: "running", detail: null });
  const result: BenchResult = { id: "test", startedAt: "", finishedAt: null, tasks: [{ task: "Task", project: "demo", runs: [run(true, 100), run(false, null)] }] };
  expect(benchTable(result)).toContain("| **All** | 100 | – | – |");
  result.tasks[0]!.runs[1]!.tokens = 0;
  expect(benchTable(result)).toContain("| **All** | 100 | 0 | 100% fewer |");
});
