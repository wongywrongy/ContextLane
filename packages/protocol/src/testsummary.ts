import { z } from "zod";

/** What a test runner, type checker or linter said at the end of its output. Absent when nothing was recognised. */
export const TestCounts = z.object({
  tool: z.string(),
  passed: z.number().int().nonnegative().nullable(),
  failed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative().nullable(),
  /** Linters and type checkers: what they found. Warnings never fail a check by themselves. */
  warnings: z.number().int().nonnegative().optional(),
});
export type TestCounts = z.infer<typeof TestCounts>;

const n = (s: string | undefined) => (s ? Number(s) : 0);
const ESC = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");

/**
 * Reads the summary line that common tools print last. Formats checked against each tool's own
 * output: vitest, jest, pytest, go test -v, node --test (TAP), tsc, mypy, ruff and eslint.
 * Unknown output gives null, and the caller shows pass or fail only.
 */
export function testSummary(output: string, command: string[] = []): TestCounts | null {
  const text = output.replace(ESC, "");
  const last = <T>(re: RegExp, f: (m: RegExpMatchArray) => T): T | null => { const all = [...text.matchAll(re)]; return all.length ? f(all.at(-1)!) : null; };
  const cmd = command.join(" ");

  // vitest:  Tests  2 failed | 42 passed | 1 skipped (45)
  const vitest = last(/^\s*Tests\s+((?:\d+ \w+(?: \| )?)+)\s*\((\d+)\)/gm, (m) => {
    const parts = Object.fromEntries([...m[1]!.matchAll(/(\d+) (\w+)/g)].map((p) => [p[2], Number(p[1])]));
    return { tool: "vitest", passed: parts.passed ?? 0, failed: parts.failed ?? 0, total: Number(m[2]) };
  });
  if (vitest) return vitest;
  // jest:  Tests:       2 failed, 42 passed, 44 total
  const jest = last(/^Tests:\s+(.*?)(\d+) total/gm, (m) => ({ tool: "jest", passed: n(/(\d+) passed/.exec(m[1]!)?.[1]), failed: n(/(\d+) failed/.exec(m[1]!)?.[1]), total: Number(m[2]) }));
  if (jest) return jest;
  // pytest:  ==== 2 failed, 42 passed, 1 skipped in 1.20s ====
  // pytest -q drops the rules:  2 failed, 42 passed in 1.20s
  const pytest = last(/^(?:=+ )?((?:\d+ (?:passed|failed|errors?|skipped|xfailed|xpassed|warnings?|deselected)(?:, )?)+) in [\d.]+s(?: \([^)]*\))?(?: =+)?$/gm, (m) => {
    const passed = n(/(\d+) passed/.exec(m[1]!)?.[1]); const failed = n(/(\d+) failed/.exec(m[1]!)?.[1]) + n(/(\d+) errors?/.exec(m[1]!)?.[1]);
    return { tool: "pytest", passed, failed, total: passed + failed };
  });
  if (pytest) return pytest;
  // node --test and other TAP:  # pass 42  # fail 2
  const tap = /^# pass (\d+)$/m.exec(text) && /^# fail (\d+)$/m.exec(text);
  if (tap) { const passed = n(/^# pass (\d+)$/m.exec(text)?.[1]); const failed = n(/^# fail (\d+)$/m.exec(text)?.[1]); return { tool: "node test", passed, failed, total: passed + failed }; }
  // go test -v:  --- PASS: TestX (0.00s)
  const goPass = [...text.matchAll(/^\s*--- PASS: /gm)].length; const goFail = [...text.matchAll(/^\s*--- FAIL: /gm)].length;
  if (goPass + goFail) return { tool: "go test", passed: goPass, failed: goFail, total: goPass + goFail };
  // mypy:  Found 3 errors in 2 files (checked 10 source files)  /  Success: no issues found in 10 source files
  const mypy = last(/^(?:Found (\d+) errors? in \d+ files? \(checked \d+ source files?\)|Success: no issues found in \d+ source files?)$/gm, (m) => ({ tool: "mypy", passed: null, failed: n(m[1]), total: null }));
  if (mypy) return mypy;
  // eslint:  ✖ 5 problems (3 errors, 2 warnings)
  const eslint = last(/✖ \d+ problems? \((\d+) errors?, (\d+) warnings?\)/g, (m) => ({ tool: "eslint", passed: null, failed: Number(m[1]), total: null, warnings: Number(m[2]) }));
  if (eslint) return eslint;
  // ruff:  Found 2 errors.  /  All checks passed!
  if (/\bruff\b/.test(cmd) || /^All checks passed!$/m.test(text)) {
    const ruff = last(/^(?:Found (\d+) errors?\.|All checks passed!)/gm, (m) => ({ tool: "ruff", passed: null, failed: n(m[1]), total: null }));
    if (ruff) return ruff;
  }
  // tsc:  Found 3 errors in 2 files.  (silent when clean)
  if (/\btsc\b|\btypecheck\b/.test(cmd) || /error TS\d+:/.test(text)) {
    const errors = last(/^Found (\d+) errors?(?: in \d+ files?)?\.$/gm, (m) => Number(m[1])) ?? [...text.matchAll(/error TS\d+:/g)].length;
    return { tool: "tsc", passed: null, failed: errors, total: null };
  }
  return null;
}
