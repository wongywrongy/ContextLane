import { describe, expect, it } from "vitest";
import { resolveLaneRefs, projectHere } from "../src/lane-ref.js";
import type { Io } from "../src/lane.js";

const io = (env: Record<string, string> = {}, cwd = "/code/shop", data: Record<string, unknown> = {}): Io => ({
  env, cwd, out: () => {}, err: () => {},
  api: (async (path: string) => data[path] ?? []) as Io["api"],
});
const here = async () => "shop";
const x = (argv: string, from: Io = io()) => resolveLaneRefs(argv.split(" "), from, here);

describe("lane references", () => {
  it("reads a bare number as a lane of this project, only where a lane is expected", async () => {
    expect(await x("delete 2 --force")).toEqual(["delete", "shop/02", "--force"]);
    expect(await x("open 1")).toEqual(["open", "shop/01"]);
    expect(await x("send 12 3")).toEqual(["send", "shop/12", "3"]);
    expect(await x("rename 1 42")).toEqual(["rename", "shop/01", "42"]);
    expect(await x("resume 7")).toEqual(["resume", "shop/07"]);
    expect(await x("auto 3 on")).toEqual(["auto", "shop/03", "on"]);
    expect(await x("app start 2 web")).toEqual(["app", "start", "shop/02", "web"]);
    expect(await x("app status 3")).toEqual(["app", "status", "shop/03"]);
    expect(await x("app restart web 4")).toEqual(["app", "restart", "web", "shop/04"]);
    expect(await x("logs web 2 -n 50")).toEqual(["logs", "web", "shop/02", "-n", "50"]);
    expect(await x("url web 1")).toEqual(["url", "web", "shop/01"]);
    expect(await x("status 1 --json")).toEqual(["status", "shop/01", "--json"]);
    expect(await x("approve 4")).toEqual(["approve", "shop/04"]);
    expect(await x("recipe 4")).toEqual(["recipe", "shop/04"]);
    expect(await x("recipe shop")).toEqual(["recipe", "shop"]);
    expect(await x("answer 1 2")).toEqual(["answer", "1", "2"]);
  });

  it("starts a lane in this project from one word, and leaves two alone", async () => {
    expect(await resolveLaneRefs(["new", "Fix the bug"], io(), here)).toEqual(["new", "shop", "Fix the bug"]);
    expect(await resolveLaneRefs(["new", "Fix the bug", "--no-agent"], io(), here)).toEqual(["new", "shop", "Fix the bug", "--no-agent"]);
    expect(await resolveLaneRefs(["new", "--branch", "feature/x", "Finish it"], io(), here)).toEqual(["new", "shop", "--branch", "feature/x", "Finish it"]);
    expect(await resolveLaneRefs(["new", "ara", "Wake word"], io(), here)).toEqual(["new", "ara", "Wake word"]);
    // Projects come first: a folder that is not one yet is not made one in passing.
    await expect(resolveLaneRefs(["new", "Try it"], io(), async () => null)).rejects.toMatchObject({ exit: 2, message: expect.stringContaining("contextlanes add") });
    expect(await resolveLaneRefs(["new"], io(), async () => null)).toEqual(["new"]);
    expect(await x("doctor --json")).toEqual(["doctor", "--json"]);
  });

  it("never turns a removed spelling into a command", async () => {
    for (const old of ["ls", "ps", "up", "down", "say 1 hi", "sh 1", "rm 1", "ok 1 2", "lanes", "term 1", "env start 1", "lane rm 1", "lane start shop Task", "restart 1"]) {
      expect(await x(old), old).toEqual(old.split(" "));
    }
  });

  it("leaves a number alone when no project can be told", async () => {
    expect(await resolveLaneRefs(["delete", "2"], io(), async () => null)).toEqual(["delete", "2"]);
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
