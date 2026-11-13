import { afterEach, expect, it } from "vitest";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runCommand } from "../src/run.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const installer = resolve("install.sh");

/** Real shell and Git; package builds, service manager and CLI are isolated stand-ins. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cl-installer-")); roots.push(root);
  const home = join(root, "home"), bin = join(root, "bin"), remote = join(root, "remote");
  const app = join(home, ".local/share/contextlanes/app"), calls = join(root, "calls");
  for (const path of [home, bin, remote]) await mkdir(path);
  const git = (...args: string[]) => runCommand("git", ["-C", remote, ...args]);
  await git("init", "-q", "-b", "candidate");
  await writeFile(join(remote, "package.json"), '{"type":"module"}');
  await writeFile(join(remote, ".gitignore"), "dist/\n");
  await git("add", ".");
  await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
  const script = async (name: string, source: string) => writeFile(join(bin, name), `#!${process.execPath}\n${source}\n`, { mode: 0o755 });
  for (const name of ["bwrap", "tmux", "systemctl"]) await script(name, "");
  await script("loginctl", 'console.log("yes");');
  const installSource = `
    import { mkdir, writeFile, symlink } from 'node:fs/promises';
    import { join } from 'node:path';
    const home = process.env.HOME, root = process.cwd();
    await mkdir(join(home, '.config/systemd/user'), {recursive:true});
    await mkdir(join(home, '.local/bin'), {recursive:true});
    await writeFile(join(home, '.config/systemd/user/contextlanes.service'), '# Installed by ContextLanes\\n');
    await writeFile(join(home, '.local/bin/contextlanes'), '#!/bin/sh\\nexit 0\\n', {mode:0o755});
    await symlink(root, join(root, '../current')).catch(e => { if(e.code !== 'EEXIST') throw e; });
    await writeFile(join(root, '../update.json'), JSON.stringify({branch:process.env.CONTEXTLANES_BRANCH}));
  `;
  const updateSource = `import {appendFile} from 'node:fs/promises'; await appendFile(process.env.CALLS, JSON.stringify({update:process.argv.slice(2)})+'\\n');`;
  await script("npm", `
    const fs = require('node:fs'), path = require('node:path');
    fs.appendFileSync(process.env.CALLS, JSON.stringify({npm:process.argv.slice(2)})+'\\n');
    if(process.argv.at(-1)==='build') {
      if(process.env.FAIL_BUILD==='1') process.exit(1);
      if(process.env.MUTATE_BUILD==='1') fs.writeFileSync('package.json', '{"type":"module","modified":true}');
      fs.mkdirSync('apps/daemon/dist', {recursive:true});
      fs.writeFileSync('apps/daemon/dist/install-main.js', ${JSON.stringify(installSource)});
      fs.writeFileSync('apps/daemon/dist/update-main.js', ${JSON.stringify(updateSource)});
    }
  `);
  const run = (extra: Record<string, string> = {}) => runCommand("sh", [installer], {
    env: { HOME: home, PATH: `${bin}:${process.env.PATH}`, CONTEXTLANES_REPO: remote, CONTEXTLANES_INSTALL_DIR: app,
      CONTEXTLANES_BRANCH: "", CALLS: calls, ...extra }, timeout: 30_000,
  });
  return { root, home, bin, app, calls, run };
}

it("resumes an interrupted first build and retains the originally selected branch", async () => {
  const f = await fixture();
  await expect(f.run({ CONTEXTLANES_BRANCH: "candidate", FAIL_BUILD: "1" })).rejects.toThrow();
  expect(await readFile(join(f.app, "../.contextlanes-installing"), "utf8")).toContain(f.app);
  await expect(readFile(join(f.home, ".config/systemd/user/contextlanes.service"))).rejects.toThrow();
  expect((await f.run()).stdout).toContain("Resuming the interrupted install");
  expect(JSON.parse(await readFile(join(f.app, "../update.json"), "utf8")).branch).toBe("candidate");
  await expect(readFile(join(f.app, "../.contextlanes-installing"))).rejects.toThrow();
  expect(JSON.parse(await readFile(join(f.app, ".contextlanes-built"), "utf8")).sha).toMatch(/^[a-f0-9]{40}$/);
});

it("delegates a rerun to the installed updater without rebuilding or changing its channel", async () => {
  const f = await fixture(); await f.run({ CONTEXTLANES_BRANCH: "candidate" });
  await writeFile(f.calls, ""); await f.run();
  expect(await readFile(f.calls, "utf8")).toBe('{"update":[]}\n');
  await writeFile(f.calls, ""); await f.run({ CONTEXTLANES_BRANCH: "stable" });
  expect(await readFile(f.calls, "utf8")).toBe('{"update":["--branch","stable"]}\n');
});

it("preserves edits in an interrupted install and refuses unrelated checkouts", async () => {
  const f = await fixture();
  await expect(f.run({ CONTEXTLANES_BRANCH: "candidate", FAIL_BUILD: "1" })).rejects.toThrow();
  await writeFile(join(f.app, "package.json"), "owner work");
  await expect(f.run()).rejects.toThrow(/local edits/);
  expect(await readFile(join(f.app, "package.json"), "utf8")).toBe("owner work");
  await rm(join(f.app, "../.contextlanes-installing"));
  await expect(f.run()).rejects.toThrow(/Refusing to overwrite/);
});

it("rejects a custom checkout name that the managed layout cannot update", async () => {
  const f = await fixture();
  await expect(f.run({ CONTEXTLANES_INSTALL_DIR: join(f.root, "wrong-name") })).rejects.toThrow(/ending in \/app/);
});

it("the real install entry preserves update history and refuses to switch away from another release", async () => {
  const f = await fixture(), dist = join(f.app, "apps/daemon/dist");
  await mkdir(dist, { recursive: true });
  await writeFile(join(f.app, "package.json"), '{"type":"module"}');
  for (const name of ["install-main", "install", "layout", "run"]) await copyFile(resolve(`apps/daemon/dist/${name}.js`), join(dist, `${name}.js`));
  const install = () => runCommand(process.execPath, [join(dist, "install-main.js")], {
    env: { HOME: f.home, PATH: `${f.bin}:${process.env.PATH}`, CONTEXTLANES_MANAGED: "1", CONTEXTLANES_BRANCH: "candidate" },
  });
  await install();
  const state = join(f.app, "../update.json"), saved = JSON.stringify({ branch: "stable", history: [{ from: "a", to: "b" }] });
  await writeFile(state, saved); await install();
  expect(await readFile(state, "utf8")).toBe(saved);
  const current = join(f.app, "../current"), other = join(f.root, "newer-release");
  await mkdir(other); await rm(current); await symlink(other, current);
  await expect(install()).rejects.toThrow(/different release is already selected/);
  expect(await realpath(current)).toBe(other);
  expect(await readFile(state, "utf8")).toBe(saved);
});

it("refuses to install when the package build changes the checked-out source", async () => {
  const f = await fixture();
  await expect(f.run({ CONTEXTLANES_BRANCH: "candidate", MUTATE_BUILD: "1" })).rejects.toThrow(/build changed tracked source/);
  await expect(readFile(join(f.home, ".config/systemd/user/contextlanes.service"))).rejects.toThrow();
});
