import { expect, it } from "vitest";
import { TerminalInput, TerminalSize } from "@contextlanes/protocol";

it("accepts shell keystrokes and bounded terminal dimensions", () => {
  expect(TerminalInput.parse({ type: "input", data: "echo café\r\u0003" })).toEqual({ type: "input", data: "echo café\r\u0003" });
  expect(TerminalInput.parse({ type: "resize", cols: 120, rows: 40 })).toEqual({ type: "resize", cols: 120, rows: 40 });
  for (const size of [{ cols: 0, rows: 24 }, { cols: 80, rows: -1 }, { cols: 80.5, rows: 24 }, { cols: 501, rows: 24 }, { cols: 80, rows: 201 }]) {
    expect(TerminalSize.safeParse(size).success).toBe(false);
  }
  expect(TerminalInput.safeParse({ type: "input", data: "x".repeat(16_385) }).success).toBe(false);
  expect(TerminalInput.safeParse({ type: "command", command: "sh" }).success).toBe(false);
});
