import { execFile, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Writable } from "node:stream";
import type { TerminalSize } from "@contextlanes/protocol";

const exec = promisify(execFile);

type Disposable = { dispose(): void };
/** A terminal the daemon holds. The PTY itself lives in a separate process (bin/pty-host.py). */
export type TerminalProcess = {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(listener: (text: string) => void): Disposable;
  onExit(listener: (e: { exitCode: number; signal?: number; error?: string }) => void): Disposable;
};
/** Runs a command without a shell. Injected everywhere so tests never touch git or tmux. */
export type Runner = {
  (cmd: string, args: string[], opts?: { cwd?: string; timeout?: number; env?: Record<string, string> }): Promise<{ stdout: string }>;
  terminal?: (cmd: string, args: string[], opts: TerminalSize & { cwd: string }) => TerminalProcess;
};

/** Commands without their own timeout are stopped after five minutes, so one hung tool never wedges a loop or a request. */
export const DEFAULT_TIMEOUT = 300_000;
export const runCommand: Runner = async (cmd, args, opts) => {
  try {
    const { stdout } = await exec(cmd, args, { cwd: opts?.cwd, timeout: opts?.timeout ?? DEFAULT_TIMEOUT, maxBuffer: 16 * 1024 * 1024, ...(opts?.env ? { env: { ...process.env, ...opts.env } } : {}) });
    return { stdout };
  } catch (err) {
    throw readable(err, cmd, args);
  }
};

/**
 * Node's message for a failed command is the whole command line, which for a lane host is hundreds of
 * characters of flags and paths, and the reason comes last. Lead with the program and what it said.
 * The error keeps stdout, stderr and code for callers that look at them.
 */
export function readable(err: unknown, cmd: string, args: string[]): unknown {
  if (!(err instanceof Error)) return err;
  const e = err as Error & { stderr?: string; stdout?: string; code?: number | string; killed?: boolean; signal?: string };
  const name = [cmd.slice(cmd.lastIndexOf("/") + 1), ...(args[0] && !args[0].startsWith("-") ? [args[0]] : [])].join(" ");
  const said = String(e.stderr ?? "").trim() || String(e.stdout ?? "").trim();
  const tail = said.split("\n").slice(-8).join("\n").slice(-1500);
  const why = e.killed || e.signal === "SIGTERM" ? "timed out" : e.code === "ENOENT" ? "is not installed" : typeof e.code === "number" ? `failed (exit ${e.code})` : "failed";
  e.message = `${name} ${why}${tail ? `: ${tail}` : e.code === "ENOENT" ? "" : `: ${e.message.split("\n")[0]!.slice(0, 300)}`}`;
  return e;
}

export const PTY_HOST = fileURLToPath(new URL("../bin/pty-host.py", import.meta.url));

/**
 * Starts `cmd` on a pseudo-terminal in its own process, as VS Code does with its pty host: if the
 * terminal crashes, only that terminal closes. No native module is loaded into the daemon.
 */
export function ptyHostTerminal(cmd: string, args: string[], opts: TerminalSize & { cwd: string }, host = PTY_HOST, python = "python3"): TerminalProcess {
  const child = spawn(python, [host, String(opts.cols), String(opts.rows), cmd, ...args], {
    cwd: opts.cwd, env: { ...process.env, TERM: "xterm-256color" }, stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  const control = child.stdio[3] as Writable;
  const decoder = new StringDecoder("utf8");
  const dataListeners = new Set<(text: string) => void>();
  const exitListeners = new Set<(e: { exitCode: number; signal?: number; error?: string }) => void>();
  let stderr = "";
  let exited: { exitCode: number; signal?: number; error?: string } | null = null;
  const finish = (e: { exitCode: number; signal?: number; error?: string }) => {
    if (exited) return;
    exited = e;
    for (const l of exitListeners) l(e);
  };
  const ignore = () => {};
  child.stdin.on("error", ignore); control.on("error", ignore);
  child.stdout.on("data", (chunk: Buffer) => { const text = decoder.write(chunk); if (text) for (const l of dataListeners) l(text); });
  child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 4096) stderr += chunk.toString(); });
  child.on("error", (err) => finish({ exitCode: -1, error: `The terminal could not start: ${err.message}` }));
  child.on("close", (code, signal) => {
    const crashed = signal !== null && signal !== "SIGTERM";
    finish({ exitCode: code ?? -1, ...(signal ? { signal: 1 } : {}), ...(crashed ? { error: `The terminal stopped (${signal}). Open it again.` } : stderr.trim() && code === 2 ? { error: stderr.trim() } : {}) });
  });
  return {
    write: (data) => { if (!exited) child.stdin.write(data); },
    resize: (cols, rows) => { if (!exited) control.write(`${Math.round(cols)} ${Math.round(rows)}\n`); },
    kill: () => { if (!exited) child.kill("SIGTERM"); },
    onData: (l) => { dataListeners.add(l); return { dispose: () => dataListeners.delete(l) }; },
    onExit: (l) => { exitListeners.add(l); if (exited) l(exited); return { dispose: () => exitListeners.delete(l) }; },
  };
}

runCommand.terminal = (cmd, args, opts) => ptyHostTerminal(cmd, args, opts);
