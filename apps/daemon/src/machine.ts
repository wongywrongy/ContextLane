import { readFile } from "node:fs/promises";
import { userInfo, type, release } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MachineInfo, type DataExport, type UpdateCheck } from "@contextlanes/protocol";
import { configPath, type Config } from "./config.js";
import { SetupError, type SetupManager } from "./setup.js";
import type { Runner } from "./run.js";
import type { Store } from "./db/store.js";

export async function machineInfo(config: Config, version: string, run: Runner): Promise<MachineInfo> {
  const user = userInfo().username;
  const [os, linger, daemon, backup, timer] = await Promise.all([
    readFile("/etc/os-release", "utf8").then((text) => text.match(/^PRETTY_NAME="(.*)"$/m)?.[1] ?? `${type()} ${release()}`, () => `${type()} ${release()}`),
    run("loginctl", ["show-user", user, "-p", "Linger", "--value"]).then((r) => r.stdout.trim(), () => null),
    run("systemctl", ["--user", "show", "contextlanes.service", "-p", "MainPID"]).then((r) => r.stdout, () => null),
    run("systemctl", ["--user", "show", "contextlanes-backup.service", "-p", "Result", "-p", "ExecMainExitTimestamp"]).then((r) => r.stdout, () => null),
    run("systemctl", ["--user", "is-enabled", "contextlanes-backup.timer"]).then((r) => r.stdout.trim() === "enabled", () => null),
  ]);
  const exited = backup?.match(/^ExecMainExitTimestamp=(.+)$/m)?.[1];
  const pid = daemon?.match(/^MainPID=(\d+)$/m)?.[1];
  const at = exited ? new Date(exited) : null;
  const lastRun = at && Number.isFinite(at.getTime()) ? at.toISOString() : null;
  return MachineInfo.parse({ host: config.host.name, os, user, version, address: `${config.listen.host}:${config.listen.port}`,
    linger: linger === "yes" ? true : linger === "no" ? false : null,
    service: pid === undefined ? null : pid === String(process.pid),
    backups: { scheduled: timer, lastRun, result: lastRun ? backup?.match(/^Result=(.*)$/m)?.[1] ?? null : null, directory: join(config.paths.data, "backups", "nightly") } });
}

export async function checkForUpdates(run: Runner): Promise<UpdateCheck> {
  try {
    const { stdout } = await run(process.execPath, [fileURLToPath(new URL("./update-main.js", import.meta.url)), "--check"], { timeout: 330_000, env: { CONTEXTLANES_CONFIG: configPath() } });
    return { lines: stdout.trim().split("\n").filter(Boolean), command: "contextlanes update" };
  } catch { throw new SetupError("The update check could not finish. Run contextlanes update --check in your SSH session for the details.", 503); }
}

export function exportData(store: Store, setup: SetupManager, config: Config, version: string): DataExport {
  const settings = setup.redactedSettings();
  const secrets = [config.notifications.ntfy?.token, config.notifications.telegram?.botToken, config.notifications.webPush?.privateKey,
    ...Object.values(config.agents).flatMap((agent) => Object.values(agent.env ?? {})), ...Object.values(config.lanes.host.env ?? {}), ...Object.values(config.lanes.toolbox.env ?? {})].filter((s): s is string => !!s);
  const redact = (value: unknown, key = "", table = ""): unknown => {
    if (/^(?:token|token_hash|secret|password|authorization|private_?key|api_?key|credential|botToken|accessToken|refreshToken)$/i.test(key) || (["owner_session", "setup_link", "notification_action"].includes(table) && key === "hash") || (table === "push_subscription" && ["endpoint", "subscription"].includes(key))) return "••••••••";
    if (key === "env" && value && typeof value === "object") return Object.fromEntries(Object.keys(value).map((k) => [k, "••••••••"]));
    if (typeof value === "string") {
      try { const parsed = JSON.parse(value); if (parsed && typeof parsed === "object") return JSON.stringify(redact(parsed, "", table)); } catch { /* Ordinary text is not JSON. */ }
      return secrets.reduce((text, secret) => text.replaceAll(secret, "••••••••"), value.replace(/(https?:\/\/)[^\s/]+@/gi, "$1••••••••@"));
    }
    if (Array.isArray(value)) return value.map((v) => redact(v, "", table));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k, table)]));
    return value;
  };
  // shortcut: unrecognised credentials pasted into prose need human review before sharing an export.
  const tables = Object.fromEntries(Object.entries(store.snapshot()).map(([name, rows]) => [name, redact(rows, "", name)]));
  return { at: new Date().toISOString(), version, settings: redact({ ...config, ...settings, lanes: { ...config.lanes, ...settings.lanes }, access: { ...config.access, ...settings.access } }), tables } as DataExport;
}
