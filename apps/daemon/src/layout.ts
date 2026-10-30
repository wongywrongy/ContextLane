import { access, readlink, realpath, rename, symlink, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Runner } from "./run.js";

/**
 * Where an installed copy lives. install.sh clones into <base>/app; each update builds a new
 * release in <base>/releases/<commit> and points <base>/current at it. The service file and the
 * command wrappers run whatever <base>/current points at.
 */
export type Layout = { base: string; repo: string; current: string; previous: string; releases: string; managed: boolean };

export const DEFAULT_BASE = (home: string) => join(home, ".local/share/contextlanes");
export const MANAGED_MARKER = ".contextlanes-managed";
export const BUILT_MARKER = ".contextlanes-built";

/** The layout around a release folder (the folder holding apps/ and packages/). */
export async function layoutOf(release: string, home: string): Promise<Layout> {
  const base = basename(dirname(release)) === "releases" ? dirname(dirname(release)) : dirname(release);
  const managed = base === DEFAULT_BASE(home) || await exists(join(base, MANAGED_MARKER)) || await exists(join(base, "current"));
  return { base, repo: join(base, "app"), current: join(base, "current"), previous: join(base, "previous"), releases: join(base, "releases"), managed };
}

/** The release the service runs now: what current points at, or the original clone before the first update. */
export async function runningRelease(layout: Layout): Promise<string> {
  return await exists(layout.current) ? realpath(layout.current) : layout.repo;
}

/** Replace a symlink in one step, so the service never sees it missing. */
export async function setLink(link: string, target: string): Promise<void> {
  const temp = `${link}.${process.pid}.tmp`;
  await unlink(temp).catch(() => {});
  await symlink(target, temp);
  await rename(temp, link);
}

export async function linkTarget(link: string): Promise<string | null> {
  try { await readlink(link); return await realpath(link); } catch { return null; }
}

export async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

/** The commit a release folder was built from, shortened the way the daemon reports it. */
export const shortSha = (sha: string) => sha.slice(0, 12);
export async function releaseVersion(run: Runner, release: string, fallback = "dev"): Promise<string> {
  try { return shortSha((await run("git", ["-C", release, "rev-parse", "HEAD"])).stdout.trim()) || fallback; } catch { return fallback; }
}
