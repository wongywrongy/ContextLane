import { LANE_AGENT_HOME, LANE_API, LANE_TOOLS } from "./names.js";

/**
 * One lane's container as `docker exec` needs it. `docker exec` gets none of the Dev Container CLI's
 * remoteEnv (docs/V4.md 8a), so every exec passes the user, the folder and the environment itself.
 */
export type LaneTarget = {
  container: string;
  /** The container's remote user (the Dev Container CLI's answer), never root unless the project's config asks for it. */
  user: string;
  /** The checkout, at its host path. */
  workdir: string;
  /** PATH inside the lane: the tools first, then the image's own. */
  path: string;
  /** The lane's own variables (CONTEXTLANES_LANE, CONTEXTLANES_URL). */
  env: Record<string, string>;
};

/** Variables passed by name only (`-e NAME`): the value goes in the docker CLI's environment, never in an argument. */
export const SECRET_ENV = new Set(["CONTEXTLANES_LANE_TOKEN"]);

/** What every process in a lane starts with, before the lane's own variables. */
export function laneEnv(target: LaneTarget, extra: Record<string, string> = {}): Record<string, string> {
  return { PATH: target.path, TERM: "xterm-256color", CLAUDE_CONFIG_DIR: `${LANE_AGENT_HOME}/claude`, CODEX_HOME: `${LANE_AGENT_HOME}/codex`, ...target.env, ...extra };
}

/** The image's PATH with the tools in front; the Debian default when the image sets none. */
export function lanePath(imagePath: string | undefined | null): string {
  return `${LANE_TOOLS}/bin:${imagePath || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}`;
}

/** The lane's own variables: which lane, and the control service by its name on the contextlanes network. */
export const laneVars = (lane: string): Record<string, string> => ({ CONTEXTLANES_LANE: lane, CONTEXTLANES_URL: LANE_API });

export type ExecOptions = {
  /** Working folder; the checkout when left out. */
  dir?: string;
  env?: Record<string, string>;
  /** Variables whose values are secret: passed as `-e NAME`, the value goes in `secrets` for the Runner's env. */
  secrets?: Record<string, string>;
  /** -d: start and return; the process keeps running in the container. */
  detach?: boolean;
  /** -i: stdin is passed (files written with the Runner's input). */
  interactive?: boolean;
  /** -t: a terminal (only for a person's attach). */
  tty?: boolean;
  /** Run as this user instead of the lane's (root only to prepare the lane's own folders). */
  user?: string;
};

/** `docker exec` argv for one command in a lane. Never --privileged; the socket is never involved. */
export function execArgv(target: LaneTarget, argv: string[], opts: ExecOptions = {}): string[] {
  const env = laneEnv(target, opts.env);
  for (const name of Object.keys(opts.secrets ?? {})) delete env[name];
  const flags = [...(opts.detach ? ["-d"] : []), ...(opts.interactive ? ["-i"] : []), ...(opts.tty ? ["-t"] : [])];
  return ["exec", ...flags, "-u", opts.user ?? target.user, "-w", opts.dir ?? target.workdir,
    ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    ...Object.keys(opts.secrets ?? {}).flatMap((k) => ["-e", k]),
    target.container, ...argv];
}
