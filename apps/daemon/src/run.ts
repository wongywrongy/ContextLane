import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import type { IPty } from "node-pty";
import type { TerminalSize } from "@contextlanes/protocol";

const exec = promisify(execFile);
const require = createRequire(import.meta.url);

/** Runs a command without a shell. Injected everywhere so tests never touch git or tmux. */
export type TerminalProcess = Pick<IPty, "write" | "resize" | "kill" | "onData" | "onExit">;
export type Runner = {
  (cmd: string, args: string[], opts?: { cwd?: string; timeout?: number; env?: Record<string, string> }): Promise<{ stdout: string }>;
  terminal?: (cmd: string, args: string[], opts: TerminalSize & { cwd: string }) => TerminalProcess;
};

export const runCommand: Runner = async (cmd, args, opts) => {
  const { stdout } = await exec(cmd, args, { cwd: opts?.cwd, timeout: opts?.timeout, maxBuffer: 16 * 1024 * 1024, ...(opts?.env ? { env: { ...process.env, ...opts.env } } : {}) });
  return { stdout };
};

runCommand.terminal = (cmd, args, opts) => {
  // A missing native build must affect only terminal attachment, never daemon startup.
  const { spawn } = require("node-pty") as typeof import("node-pty");
  return spawn(cmd, args, { ...opts, name: "xterm-256color", env: process.env });
};
