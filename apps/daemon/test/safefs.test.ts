import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { copyFileInside, copyInside, copyTreeInside, readInside, withDirectoryInside, writeInside } from "../src/safefs.js";
import { endpoint } from "../src/localmodels.js";

const roots: string[] = [];
afterEach(async () => { for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cl-safe-")); roots.push(root);
  const lane = join(root, "lane"); const secret = join(root, "data", "setup-token");
  await mkdir(join(lane, "src"), { recursive: true }); await mkdir(join(root, "data"));
  await writeFile(secret, "owner-secret"); await writeFile(join(lane, "src/a.ts"), "export const a = 1;\n");
  return { root, lane, secret };
}

describe("files in a checkout an agent controls", () => {
  it("reads regular files inside it, not symlinks out of it, FIFOs or devices", async () => {
    const f = await fixture();
    expect(await readInside(f.lane, "src/a.ts", 1000)).toEqual({ text: "export const a = 1;\n", size: 20 });
    expect((await readInside(f.lane, "src/a.ts", 6))!.text).toBe("export");
    await symlink(f.secret, join(f.lane, "notes.txt"));
    await symlink(join(f.root, "data"), join(f.lane, "d"));
    await symlink("/dev/zero", join(f.lane, "zero"));
    await promisify(execFile)("mkfifo", [join(f.lane, "pipe")]);
    for (const p of ["notes.txt", "d/setup-token", "../data/setup-token", "zero", "pipe", "missing"]) expect(await readInside(f.lane, p, 1000)).toBeNull();
    // An inside symlink to an inside file is fine.
    await symlink("src/a.ts", join(f.lane, "alias.ts"));
    expect((await readInside(f.lane, "alias.ts", 1000))!.text).toContain("a = 1");
  });

  it("copies untracked files as they are: symlinks stay symlinks, nothing is read through them", async () => {
    const f = await fixture(); const to = join(f.root, "fork"); await mkdir(to);
    await symlink(f.secret, join(f.lane, "notes.txt"));
    await symlink(join(f.root, "data"), join(f.lane, "d"));
    expect(await copyInside(f.lane, to, "src/a.ts")).toBe(true);
    expect(await copyInside(f.lane, to, "notes.txt")).toBe(true);
    expect(await copyInside(f.lane, to, "d/setup-token")).toBe(false);
    expect(await readFile(join(to, "src/a.ts"), "utf8")).toContain("a = 1");
    expect((await lstat(join(to, "notes.txt"))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(to, "notes.txt"))).toBe(f.secret);
  });

  it("refuses to write through a symlink anywhere on the path", async () => {
    const f = await fixture();
    await writeInside(f.lane, ".claude/skills/x/SKILL.md", "hi");
    expect(await readFile(join(f.lane, ".claude/skills/x/SKILL.md"), "utf8")).toBe("hi");
    await symlink(join(f.root, "data"), join(f.lane, ".agents"));
    await expect(writeInside(f.lane, ".agents/skills/x/SKILL.md", "hi")).rejects.toThrow(/symlink/);
    await mkdir(join(f.lane, "y")); await symlink(f.secret, join(f.lane, "y/SKILL.md"));
    await expect(writeInside(f.lane, "y/SKILL.md", "overwrite")).rejects.toThrow(/symlink/);
    expect(await readFile(f.secret, "utf8")).toBe("owner-secret");
  });

  it("keeps directory operations on the opened folder when its pathname changes", async () => {
    const f = await fixture();
    await withDirectoryInside(f.lane, "src", async (path) => {
      await rename(join(f.lane, "src"), join(f.lane, "saved"));
      await symlink(join(f.root, "data"), join(f.lane, "src"));
      await writeFile(join(path, "safe.txt"), "inside");
      expect(await readFile(join(path, "a.ts"), "utf8")).toContain("a = 1");
    });
    expect(await readFile(join(f.lane, "saved/safe.txt"), "utf8")).toBe("inside");
    await expect(readFile(join(f.root, "data/safe.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readInside(f.lane, "src/setup-token", 100)).toBeNull();
    await expect(writeInside(f.lane, "src/setup-token", "changed")).rejects.toThrow(/symlink/);
    expect(await readFile(f.secret, "utf8")).toBe("owner-secret");
  });

  it("refuses a replaced checkout root and source parents when copying", async () => {
    const f = await fixture(), target = join(f.root, "target"); await mkdir(target);
    await symlink(join(f.root, "data"), join(f.lane, "external"));
    expect(await copyFileInside(f.lane, target, "external/setup-token")).toBe(false);
    await rename(f.lane, join(f.root, "saved")); await symlink(join(f.root, "data"), f.lane);
    expect(await readInside(f.lane, "setup-token", 100)).toBeNull();
    expect(await copyInside(f.lane, target, "setup-token")).toBe(false);
    await expect(writeInside(f.lane, "setup-token", "changed")).rejects.toThrow();
    expect(await readFile(f.secret, "utf8")).toBe("owner-secret");
  });

  it("copies dependency trees independently and preserves links without reading their targets", async () => {
    const f = await fixture(), target = join(f.root, "target"); await mkdir(target);
    await symlink(f.secret, join(f.lane, "src/alias"));
    expect(await copyTreeInside(f.lane, target, "src")).toBe(true);
    await writeFile(join(target, "src/a.ts"), "new dependency");
    expect(await readFile(join(f.lane, "src/a.ts"), "utf8")).toContain("a = 1");
    expect(await readlink(join(target, "src/alias"))).toBe(f.secret);
    expect(await copyTreeInside(f.lane, target, "src")).toBe(false);
    expect(await readFile(join(target, "src/a.ts"), "utf8")).toBe("new dependency");
    await expect(copyFileInside(f.lane, target, "src/a.ts")).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("keeps a local model's base path", () => {
    expect(endpoint("http://h:8080/llm", "/v1/chat/completions").href).toBe("http://h:8080/llm/v1/chat/completions");
    expect(endpoint("http://127.0.0.1:11434", "/api/tags").href).toBe("http://127.0.0.1:11434/api/tags");
  });
});
