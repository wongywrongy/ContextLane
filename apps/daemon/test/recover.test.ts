import { describe, expect, it } from "vitest";
import { Config, EventBus, Store, type Runner } from "@contextlanes/daemon";
import { recover } from "../src/recover.js";

describe("startup recovery", () => {
  it("settles lanes a restart caught mid-setup and stops leftover screenshot services", async () => {
    const store = Store.open(":memory:");
    store.addProject({ id: "shop", name: "Shop", path: "/code/shop" });
    const lane = (n: number, state: string) => store.insertLane({ id: `shop/0${n}`, n, project: "shop", goal: null, task: "t", agent: "claude-code", model: null, mode: "default", branch: `b${n}`, worktree: `/w${n}`, terminal: `t${n}`, hostUnit: `unit-${n}`, base: "main", state: "draft", colour: "lc1" } as never) && state !== "draft" && store.setLaneState(`shop/0${n}`, state as never);
    lane(1, "draft"); lane(2, "setting_up"); lane(3, "setting_up"); lane(4, "setting_up"); store.setLaneState("shop/04", "working");
    const calls: string[] = [];
    const run: Runner = async (cmd, args) => {
      calls.push([cmd, ...args].join(" "));
      if (args.includes("is-active")) { if (args.includes("unit-3")) return { stdout: "" }; throw new Error("inactive"); }
      if (args[1] === "list-units") return { stdout: "contextlanes-env-before-ab12.service loaded active running x\n" };
      return { stdout: "" };
    };
    const done = await recover({ store, bus: new EventBus(), config: Config.parse({ paths: { data: "/tmp/cl-recover", lanes: "/tmp/cl-recover/lanes" } }), run });
    expect(["shop/01", "shop/02", "shop/03", "shop/04"].map((id) => store.getLane(id)!.state)).toEqual(["archived", "failed", "working", "working"]);
    expect(done).toContain("stopped contextlanes-env-before-ab12.service");
    expect(calls).toContain("git worktree prune");
  });
});
