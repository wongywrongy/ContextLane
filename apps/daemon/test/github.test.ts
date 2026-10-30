import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CloneRequest } from "@contextlanes/protocol";
import type { Runner } from "@contextlanes/daemon";
import { GitHub } from "../src/github.js";

const roots: string[] = [];
afterEach(async () => { for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });
const folder = async () => { const r = await mkdtemp(join(tmpdir(), "cl-gh-")); roots.push(r); return join(r, "code"); };

describe("Add from GitHub", () => {
  it("says why when gh is missing or signed out", async () => {
    const missing: Runner = async () => { throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }); };
    expect(await new GitHub(missing, "/c").list()).toEqual({ available: false, reason: expect.stringMatching(/not installed/) });
    const out: Runner = async () => { throw Object.assign(new Error("exit 1"), { code: 1 }); };
    expect(await new GitHub(out, "/c").list()).toEqual({ available: false, reason: expect.stringMatching(/gh auth login/) });
  });

  it("lists repositories newest first and marks ones already cloned", async () => {
    const code = await folder(); await mkdir(join(code, "shop/.git"), { recursive: true });
    const run: Runner = async (_cmd, args) => ({ stdout: args[0] === "repo" ? JSON.stringify([
      { nameWithOwner: "k/old", description: "", isPrivate: false, updatedAt: "2025-01-01T00:00:00Z" },
      { nameWithOwner: "k/shop", description: "Shop", isPrivate: true, updatedAt: "2026-10-01T00:00:00Z" }]) : "" });
    const listing = await new GitHub(run, code).list();
    expect(listing.available && listing.repos.map((r) => [r.name, r.cloned, r.private])).toEqual([["k/shop", true, true], ["k/old", false, false]]);
  });

  it("clones into the code folder, reuses the same repository, and refuses a different one in the way", async () => {
    const code = await folder();
    const calls: string[][] = [];
    const run: Runner = async (cmd, args) => { calls.push([cmd, ...args]); if (cmd === "gh") await mkdir(join(args[3]!, ".git"), { recursive: true }); return { stdout: cmd === "git" ? "https://github.com/k/shop.git\n" : "" }; };
    const gh = new GitHub(run, code);
    expect(await gh.clone(CloneRequest.parse({ repo: "k/shop" }))).toBe(join(code, "shop"));
    expect(calls[0]).toEqual(["gh", "repo", "clone", "k/shop", join(code, "shop"), "--", "--quiet"]);
    expect(await gh.clone(CloneRequest.parse({ repo: "k/shop" }))).toBe(join(code, "shop")); // already there: reused
    await expect(new GitHub(async () => ({ stdout: "git@github.com:other/shop.git" }), code).clone(CloneRequest.parse({ repo: "k/shop" }))).rejects.toThrow(/different repository/);
    expect(() => CloneRequest.parse({ repo: "../etc" })).toThrow();
    expect(() => CloneRequest.parse({ repo: "k/.." })).toThrow();
  });
});
