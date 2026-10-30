import { describe, expect, it } from "vitest";
import { testSummary } from "../src/testsummary.js";

describe("test summaries", () => {
  it("reads vitest, jest, pytest, TAP and go test", () => {
    expect(testSummary(" Test Files  3 passed (3)\n      Tests  2 failed | 42 passed | 1 skipped (45)\n   Start at  10:00")).toEqual({ tool: "vitest", passed: 42, failed: 2, total: 45 });
    expect(testSummary("\u001b[1mTests:\u001b[22m       \u001b[31m2 failed\u001b[39m, 42 passed, 44 total")).toEqual({ tool: "jest", passed: 42, failed: 2, total: 44 });
    expect(testSummary("=========== 2 failed, 42 passed, 1 skipped in 1.20s ===========")).toEqual({ tool: "pytest", passed: 42, failed: 2, total: 44 });
    expect(testSummary("==== 44 passed in 0.31s ====")).toEqual({ tool: "pytest", passed: 44, failed: 0, total: 44 });
    expect(testSummary("..F\n1 failed, 1 passed in 0.02s")).toEqual({ tool: "pytest", passed: 1, failed: 1, total: 2 });
    expect(testSummary("TAP version 13\nok 1 - a\n# tests 2\n# pass 1\n# fail 1\n")).toEqual({ tool: "node test", passed: 1, failed: 1, total: 2 });
    expect(testSummary("=== RUN   TestA\n--- PASS: TestA (0.00s)\n--- FAIL: TestB (0.01s)\nFAIL")).toEqual({ tool: "go test", passed: 1, failed: 1, total: 2 });
  });
  it("reads type checkers and linters", () => {
    expect(testSummary("Success: no issues found in 12 source files")).toMatchObject({ tool: "mypy", failed: 0 });
    expect(testSummary("a.py:3: error: x\nFound 3 errors in 2 files (checked 12 source files)")).toMatchObject({ tool: "mypy", failed: 3 });
    expect(testSummary("\n✖ 5 problems (3 errors, 2 warnings)\n")).toMatchObject({ tool: "eslint", failed: 3, warnings: 2 });
    expect(testSummary("All checks passed!")).toMatchObject({ tool: "ruff", failed: 0 });
    expect(testSummary("x.py:1:1: F401 unused\nFound 2 errors.", ["ruff", "check"])).toMatchObject({ tool: "ruff", failed: 2 });
    expect(testSummary("", ["pnpm", "exec", "tsc", "--noEmit"])).toMatchObject({ tool: "tsc", failed: 0 });
    expect(testSummary("src/a.ts(1,1): error TS2304: x\nFound 1 error in src/a.ts:1\n\nFound 1 error.")).toMatchObject({ tool: "tsc", failed: 1 });
  });
  it("says nothing about output it does not recognise", () => {
    expect(testSummary("built in 3.2s")).toBeNull();
    expect(testSummary("Found 2 errors.")).toBeNull();
  });
});
