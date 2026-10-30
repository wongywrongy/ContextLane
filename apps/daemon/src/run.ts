import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { spawn as spawnPty, type IPty } from "node-pty";
import type { TerminalSize } from "@contextlanes/protocol";

const exec = promisify(execFile);

/** Runs a command without a shell. Injected everywhere so tests never touch git or tmux. */
export type TerminalProcess = Pick<IPty, "write" | "resize" | "kill" | "onData" | "onExit">;
export type Runner = {
  (cmd: string, args: string[], opts?: { cwd?: string }): Promise<{ stdout: string }>;
  terminal?: (cmd: string, args: string[], opts: TerminalSize & { cwd: string }) => TerminalProcess;
};

export const runCommand: Runner = async (cmd, args, opts) => {
  const { stdout } = await exec(cmd, args, { cwd: opts?.cwd, maxBuffer: 16 * 1024 * 1024 });
  return { stdout };
};

runCommand.terminal = (cmd, args, opts) => spawnPty(cmd, args, { ...opts, name: "xterm-256color", env: process.env });
