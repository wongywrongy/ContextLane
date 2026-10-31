/** A test runner by what runs, not by paths in the line: "pnpm test", "vitest run", "pytest -q"; never "sed tests/x.ts". */
const RUNNER = /^((pnpm|npm|yarn|bun)( run)? (test|test:\S+|e2e|check)|(npx |pnpm exec |bunx )?(vitest|jest|mocha|playwright test|pytest|tsc)|python3? pytest|go test|cargo test|make (test|check)|deno test|rspec|phpunit)\b/;
/** Claude titles a command with what it does: "Run pnpm test", "Run the unit tests". */
const DESCRIBED = /^run(ning)?\s+(the\s+)?([\w:-]+\s+){0,2}(tests?|specs?|test suite)\b/i;
export function isTestCommand(line: string): boolean {
  if (DESCRIBED.test(line.trim())) return true;
  line = line.replace(/^run(ning)?\s+/i, "");
  return line.split(/&&|\|\||;|\|/).some((part) => {
    const words = part.trim().replace(/^(\w+=\S*\s+)+/, "");
    // "pnpm vitest", "npx jest", "uv run pytest": the runner after the package tool.
    return RUNNER.test(words) || RUNNER.test(words.replace(/^(npx|pnpm exec|pnpm|yarn|bunx|bun|uv run|poetry run)\s+/, ""));
  });
}
