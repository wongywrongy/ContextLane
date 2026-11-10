import { describe, expect, it } from "vitest";
import { expandShort, projectHere } from "../src/short.js";
import type { Io } from "../src/lane.js";

const io = (env: Record<string, string> = {}, cwd = "/code/shop", data: Record<string, unknown> = {}): Io => ({
  env, cwd, out: () => {}, err: () => {},
  api: (async (path: string) => data[path] ?? []) as Io["api"],
});
const here = async () => "shop";
const x = (argv: string, from: Io = io()) => expandShort(argv.split(" "), from, here);

describe("short commands", () => {
  it("expands the verbs to the long commands", async () => {
    expect(await x("ls")).toEqual(["lanes"]);
    expect(await x("ps")).toEqual(["env"]);
    expect(await x("up")).toEqual(["env", "start"]);
    expect(await x("up web api")).toEqual(["env", "start", "web", "api"]);
    expect(await x("down")).toEqual(["env", "stop"]);
    expect(await x("restart web")).toEqual(["env", "restart", "web"]);
    expect(await x("ok shop/01#r1 allow")).toEqual(["answer", "shop/01#r1", "allow"]);
  });

  it("reads a bare number as a lane of this project, only where a lane is expected", async () => {
    expect(await x("rm 2 --force")).toEqual(["lane", "rm", "shop/02", "--force"]);
    expect(await x("sh 1")).toEqual(["term", "shop/01"]);
    expect(await x("say 12 3")).toEqual(["send", "shop/12", "3"]);
    expect(await x("rename 1 42")).toEqual(["lane", "rename", "shop/01", "42"]);
    expect(await x("auto 3 on")).toEqual(["lane", "auto", "shop/03", "on"]);
    expect(await x("up 2 web")).toEqual(["env", "start", "shop/02", "web"]);
    expect(await x("logs web 2 -n 50")).toEqual(["logs", "web", "shop/02", "-n", "50"]);
    expect(await x("url web 1")).toEqual(["url", "web", "shop/01"]);
    expect(await x("status 1 --json")).toEqual(["status", "shop/01", "--json"]);
    expect(await x("recipe approve 4")).toEqual(["recipe", "approve", "shop/04"]);
    expect(await x("recipe shop")).toEqual(["recipe", "shop"]);
    expect(await x("ok 1 2")).toEqual(["answer", "1", "2"]);
  });

  it("starts a lane in this project from one word, and passes the long form through", async () => {
    expect(await expandShort(["new", "Fix the bug"], io(), here)).toEqual(["lane", "start", "shop", "Fix the bug"]);
    expect(await expandShort(["new", "Fix the bug", "--no-agent"], io(), here)).toEqual(["lane", "start", "shop", "Fix the bug", "--no-agent"]);
    expect(await expandShort(["new", "ara", "Wake word"], io(), here)).toEqual(["lane", "start", "ara", "Wake word"]);
    // Projects come first: a folder that is not one yet is not made one in passing.
    await expect(expandShort(["new", "Try it"], io(), async () => null)).rejects.toMatchObject({ exit: 2, message: expect.stringContaining("cl add") });
    expect(await expandShort(["new"], io(), async () => null)).toEqual(["lane", "start"]);
    expect(await x("lane start shop Task")).toEqual(["lane", "start", "shop", "Task"]);
    expect(await x("env start shop/01")).toEqual(["env", "start", "shop/01"]);
    expect(await x("doctor --json")).toEqual(["doctor", "--json"]);
  });

  it("leaves a number alone when no project can be told", async () => {
    expect(await expandShort(["rm", "2"], io(), async () => null)).toEqual(["lane", "rm", "2"]);
  });

  it("finds the project from the lane, the project folder or a lane checkout", async () => {
    expect(await projectHere(io({ CONTEXTLANES_LANE: "ara/03" }))).toBe("ara");
    const data = { "/api/projects": [{ id: "shop", path: "/code/shop" }, { id: "ara", path: "/code/ara" }], "/api/lanes": [{ project: "ara", worktree: "/lanes/ara/01-x" }] };
    expect(await projectHere(io({}, "/code/shop/src", data))).toBe("shop");
    expect(await projectHere(io({}, "/lanes/ara/01-x/app", data))).toBe("ara");
    expect(await projectHere(io({}, "/tmp", data))).toBeNull();
    expect(await projectHere(io({}, "/tmp", { "/api/projects": [{ id: "shop", path: "/code/shop" }] }))).toBe("shop");
  });
});
