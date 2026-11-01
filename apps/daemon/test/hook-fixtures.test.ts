import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
it("keeps credentials and unrelated account-credit metadata out of captured fixtures", async () => {
  const root = fileURLToPath(new URL("./fixtures/hooks/", import.meta.url));
  const audit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      expect(key).not.toMatch(/^(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|credits|balance)$/i);
      audit(child);
    }
  };
  for (const file of await readdir(root, { recursive: true })) {
    if (!/\.jsonl?$/.test(file)) continue;
    const text = await readFile(join(root, file), "utf8");
    for (const row of file.endsWith(".jsonl") ? text.trim().split("\n") : [text]) audit(JSON.parse(row));
  }
});
