import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { folderArg, hereFolder } from "../src/here.js";
import { resolveLaneRefs } from "../src/lane-ref.js";
import type { Io } from "../src/lane.js";
import type { Project } from "@contextlanes/protocol";

describe("the folder a command runs in", () => {
  it("is the process's own folder, unless the host command passed one", () => {
    expect(hereFolder({}, () => "/inside/the/container")).toBe("/inside/the/container");
    expect(hereFolder({ CONTEXTLANES_CWD: "" }, () => "/x")).toBe("/x");
    expect(hereFolder({ CONTEXTLANES_CWD: "/home/kyle/code/shop/src" }, () => "/")).toBe("/home/kyle/code/shop/src");
    expect(hereFolder({ CONTEXTLANES_CWD: "/" }, () => "/x")).toBe("/");
  });

  it("refuses a passed folder that is not an absolute, normal path, as wrong usage", () => {
    for (const bad of ["code/shop", "~/code", "/home/kyle/../root", "/home//kyle", "/home/kyle/", "/a/./b", "/a\nb"]) {
      expect(() => hereFolder({ CONTEXTLANES_CWD: bad }), JSON.stringify(bad)).toThrow(expect.objectContaining({ exit: 2, code: "usage" }));
    }
  });

  it("resolves a folder named on the command line against it", () => {
    expect(folderArg(undefined, "/home/kyle/code")).toBe("/home/kyle/code");
    expect(folderArg("shop", "/home/kyle/code")).toBe("/home/kyle/code/shop");
    expect(folderArg("../other", "/home/kyle/code/shop")).toBe("/home/kyle/code/other");
    expect(folderArg("/srv/shop", "/home/kyle")).toBe("/srv/shop");
  });

  it("finds this project from the passed folder, not the container's", async () => {
    const projects: Project[] = [{ id: "shop", name: "Shop", path: "/home/kyle/code/shop", remote: null, recipeHash: null, pinned: false }];
    const io: Io = { env: {}, cwd: hereFolder({ CONTEXTLANES_CWD: "/home/kyle/code/shop/src" }, () => "/"), out: () => {}, err: () => {},
      api: (async (path: string) => (path === "/api/projects" ? projects : [])) as Io["api"] };
    expect(await resolveLaneRefs(["delete", "2"], io)).toEqual(["delete", "shop/02"]);
    expect(await resolveLaneRefs(["new", "Fix it"], io)).toEqual(["new", "shop", "Fix it"]);
  });

  it("the real command exits 2 with a JSON usage error for a bad CONTEXTLANES_CWD, before asking the daemon", () => {
    const tsx = fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url));
    const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
    const done = spawnSync(tsx, [main, "projects", "--json"], { encoding: "utf8", env: { ...process.env, CONTEXTLANES_URL: "http://127.0.0.1:1", CONTEXTLANES_CWD: "relative/path" } });
    expect(done.status).toBe(2);
    expect(done.stdout).toBe("");
    expect(JSON.parse(done.stderr)).toMatchObject({ code: "usage", error: expect.stringContaining("CONTEXTLANES_CWD") });
  }, 30_000);
});

import { ownFile } from "../src/client.js";

describe("whose setup-token the command accepts", () => {
  it("takes its own file, and any owner's when it runs as root in the control container", () => {
    expect(ownFile(1000, 1000)).toBe(true);
    expect(ownFile(1000, 1001)).toBe(false);
    expect(ownFile(1000, 0)).toBe(true);
    expect(ownFile(0, 1000)).toBe(false);
  });
});
