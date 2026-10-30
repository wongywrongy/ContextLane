import { describe, expect, it } from "vitest";
import { RoutingRule, routeTask } from "../src/setup.js";

describe("routing", () => {
  const rules = [RoutingRule.parse({ words: ["docs", "fixture", "rename"], agent: "opencode", model: "qwen3-coder:30b", label: "saves cloud" }), RoutingRule.parse({ words: ["test"], agent: "codex" })];
  it("picks the first rule with a word at the start of a word in the task", () => {
    expect(routeTask(rules, "Write the Docs for billing")?.agent).toBe("opencode");
    expect(routeTask(rules, "Add tests for the solver")?.agent).toBe("codex");
    expect(routeTask(rules, "Fix the fixture loader and its tests")?.agent).toBe("opencode");
    expect(routeTask(rules, "Billing phase 0")).toBeNull();
    expect(routeTask(rules, "contest page")).toBeNull();
  });
  it("treats words literally", () => {
    expect(routeTask([RoutingRule.parse({ words: ["c++"], agent: "codex" })], "port the c++ parser")?.agent).toBe("codex");
  });
});
