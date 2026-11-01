import { expect, it } from "vitest";
import { keyAction } from "../src/keys";
const key = (key: string, extra: object = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, defaultPrevented: false, ...extra });
it("maps the requested shortcuts and supports Ctrl on Linux", () => {
  expect(keyAction(key("3", { metaKey: true }), false)).toEqual({ lane: 2 });
  expect(keyAction(key("d", { ctrlKey: true, shiftKey: true }), false)).toBe("split-down");
  for (const [input, action] of [[":", "palette"], ["?", "help"], ["j", "next"], ["k", "previous"], ["a", "answer"], ["r", "review"]]) expect(keyAction(key(input!), false)).toBe(action);
});
it("leaves typing, terminal, composition and open dialogs alone", () => {
  expect(keyAction(key("k", { metaKey: true }), true)).toBeNull();
  expect(keyAction(key("d", { ctrlKey: true }), true)).toBeNull();
  expect(keyAction(key("r", { isComposing: true }), false)).toBeNull();
  expect(keyAction(key("j"), false, true)).toBeNull();
  expect(keyAction(key("r", { altKey: true }), false)).toBeNull();
});
