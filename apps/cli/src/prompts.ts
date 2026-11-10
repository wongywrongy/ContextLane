import * as clack from "@clack/prompts";
import { CANCEL, type Ask } from "./interactive.js";

const or = <T>(value: unknown): T | typeof CANCEL => clack.isCancel(value) ? CANCEL : value as T;

/** The terminal's questions, drawn by @clack/prompts: arrows to move, Enter to choose, Esc to back out. */
export const terminal: Ask = {
  select: async (message, options) => or(await clack.select({ message, options: options as never })) as never,
  text: async (message, placeholder) => or<string>(await clack.text({ message, ...(placeholder ? { placeholder } : {}), validate: (v) => v?.trim() ? undefined : "Type something, or press Esc to cancel." })),
  confirm: async (message) => or<boolean>(await clack.confirm({ message, initialValue: false })),
  note: (text) => clack.log.message(text),
};
