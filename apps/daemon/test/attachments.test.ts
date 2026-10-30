import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Config, type Runner } from "@contextlanes/daemon";
import type { Lane } from "@contextlanes/protocol";
import { PromptRequest } from "@contextlanes/protocol";
import { attach, laneFiles } from "../src/attachments.js";
import { hostCommand } from "../src/lanes/manager.js";

const roots: string[] = [];
afterEach(async () => { for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cl-attach-"))); roots.push(root);
  const worktree = join(root, "lane"); await mkdir(join(worktree, "src"), { recursive: true });
  await writeFile(join(worktree, "src/fees.ts"), "x"); await writeFile(join(root, "outside.txt"), "secret");
  await symlink(join(root, "outside.txt"), join(worktree, "link.txt"));
  const config = Config.parse({ paths: { data: join(root, "data"), lanes: join(root, "lanes") } });
  return { root, worktree, config, lane: { id: "shop/01", worktree } as Lane };
}

describe("composer attachments", () => {
  it("accepts files in the checkout and refuses anything outside it, symlinks included", async () => {
    const { config, lane } = await fixture();
    expect((await attach(config, lane, PromptRequest.parse({ text: "look", files: ["src/fees.ts"] }))).files).toEqual(["src/fees.ts"]);
    expect(() => PromptRequest.parse({ text: "x", files: ["../outside.txt"] })).toThrow();
    await expect(attach(config, lane, PromptRequest.parse({ text: "x", files: ["link.txt"] }))).rejects.toThrow(/not a file in this lane's checkout/);
    await expect(attach(config, lane, PromptRequest.parse({ text: "x", files: ["src"] }))).rejects.toThrow(/not a file/);
  });

  it("saves pictures where the sandboxed host can read them and keeps only the path in the command", async () => {
    const { config, lane } = await fixture();
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    const command = await attach(config, lane, PromptRequest.parse({ text: "this screen", images: [{ mimeType: "image/png", data: png.toString("base64") }] }));
    expect(command.images[0]!.path.startsWith(join(config.paths.lanes, ".attachments", "shop-01"))).toBe(true);
    expect(await readFile(command.images[0]!.path)).toEqual(png);
    expect(JSON.stringify(command)).not.toContain(png.toString("base64"));
    expect(() => PromptRequest.parse({ text: "x", images: [{ mimeType: "image/svg+xml", data: "AA==" }] })).toThrow();
  });

  it("lists files for @ file, best matches first", async () => {
    const run: Runner = async () => ({ stdout: ["README.md", "src/billing/fees.ts", "fees.ts", "docs/fees-old.md"].join("\0") });
    expect(await laneFiles(run, { worktree: "/w" } as Lane, "fees")).toEqual(["fees.ts", "docs/fees-old.md", "src/billing/fees.ts"]);
  });

  it("hands a Take over's handoff to the agent as its first message", () => {
    const args = hostCommand({ id: "shop/02", worktree: "/w", task: "Continue: add invoices", agent: "claude-code", model: null, mode: "ask" } as Lane, Config.parse({}), undefined, "You are taking over…");
    expect(args).toContain("--task=You are taking over…");
  });
});
