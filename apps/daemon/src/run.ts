import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Runs a command without a shell. Injected everywhere so tests never touch git or tmux. */
export type Runner = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<{ stdout: string }>;

export const runCommand: Runner = async (cmd, args, opts) => {
  const { stdout } = await exec(cmd, args, { cwd: opts?.cwd, maxBuffer: 16 * 1024 * 1024 });
  return { stdout };
};
