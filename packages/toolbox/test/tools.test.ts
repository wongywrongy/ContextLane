import { describe, expect, it } from "vitest";
import { createToolbox, TOOL_NAMES, TOOLS } from "@contextlanes/toolbox";

describe("toolbox", () => {
  it("offers the eight lane tools", () => {
    expect(TOOL_NAMES).toEqual(["env_status", "env_start", "get_logs", "preview_url", "ask_owner", "checkpoint", "get_brief", "delegate"]);
  });
  it("validates delegate input", () => {
    expect(TOOLS.delegate.input.parse({ kind: "read", task: "summarise the failing tests" })).toEqual({ kind: "read", task: "summarise the failing tests", files: [] });
    expect(() => TOOLS.delegate.input.parse({ kind: "deploy", task: "x" })).toThrow();
  });
  it("builds an MCP server", () => {
    expect(createToolbox({ daemonUrl: "http://127.0.0.1:4600", lane: "shuttleworks/01" })).toBeDefined();
  });
});
