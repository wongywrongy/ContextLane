import { mkdir, readFile, rm, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { Schedule, type Lane, type ScheduleView } from "@contextlanes/protocol";
import type { Config } from "./config.js";
import type { Store } from "./db/store.js";
import { NotFound, Refused, type LaneManager } from "./lanes/manager.js";
import type { Runner } from "./run.js";
import type { SetupManager } from "./setup.js";

const MARKER = "# Installed by ContextLanes";
const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;

/**
 * Scheduled lanes (4.5): each schedule is a systemd user timer with Persistent=true, so a run missed
 * while the machine was off happens at the next boot. The timer runs `contextlanes schedule run <id>`,
 * which asks the daemon to start the lane like any other. A scheduled lane never merges.
 */
export class Schedules {
  constructor(private deps: { config: Config; store: Store; lanes: LaneManager; setup: SetupManager; run: Runner; home: string; node: string; cli: string }) {}
  private dir() { return join(this.deps.home, ".config/systemd/user"); }
  private unit(id: string) { return `contextlanes-schedule-${id}`; }

  /** systemd's own reading of the expression, so a typo is caught before a timer is written. */
  private async next(when: string): Promise<string | null> {
    const out = await this.deps.run("systemd-analyze", ["calendar", "--iterations=1", when], { timeout: 5000 }).then((r) => r.stdout, () => null);
    return out ? /Next elapse:\s*(.+)/.exec(out)?.[1]?.trim() ?? null : null;
  }

  async list(): Promise<ScheduleView[]> {
    return Promise.all(this.deps.config.schedules.map(async (s) => {
      const last = this.deps.store.listLanes(s.project).filter((l) => l.goal === `Scheduled: ${s.id}`).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      return { ...s, next: await this.next(s.when), lastLane: last?.id ?? null };
    }));
  }

  async add(input: unknown): Promise<ScheduleView[]> {
    const s = Schedule.parse(input);
    if (!this.deps.store.getProject(s.project)) throw new NotFound("no such project");
    if (this.deps.config.schedules.some((x) => x.id === s.id)) throw new Refused(`There is already a schedule called ${s.id}.`);
    if (!(await this.next(s.when))) throw new Refused(`systemd does not understand "${s.when}". Try "Mon..Fri 07:30" or "*-*-* 02:00".`);
    await mkdir(this.dir(), { recursive: true, mode: 0o700 });
    const write = async (file: string, text: string) => {
      const path = join(this.dir(), file);
      const current = await readFile(path, "utf8").catch(() => null);
      if (current !== null && !current.startsWith(MARKER)) throw new Refused(`Refusing to overwrite ${path}; it was not written by ContextLanes.`);
      await writeFile(`${path}.tmp`, text, { mode: 0o600 }); await rename(`${path}.tmp`, path);
    };
    await write(`${this.unit(s.id)}.service`, `${MARKER}\n[Unit]\nDescription=ContextLanes scheduled lane ${s.id}\n\n[Service]\nType=oneshot\nExecStart=${quote(this.deps.node)} ${quote(this.deps.cli)} schedule run ${s.id}\n`);
    await write(`${this.unit(s.id)}.timer`, `${MARKER}\n[Unit]\nDescription=ContextLanes scheduled lane ${s.id}\n\n[Timer]\nOnCalendar=${s.when}\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`);
    await this.deps.run("systemctl", ["--user", "daemon-reload"]);
    await this.deps.run("systemctl", ["--user", "enable", "--now", `${this.unit(s.id)}.timer`]);
    await this.deps.setup.update({ schedules: [...this.deps.config.schedules, s] });
    return this.list();
  }

  async remove(id: string): Promise<ScheduleView[]> {
    if (!this.deps.config.schedules.some((s) => s.id === id)) throw new NotFound("no such schedule");
    await this.deps.run("systemctl", ["--user", "disable", "--now", `${this.unit(id)}.timer`]).catch(() => {});
    for (const ext of ["timer", "service"]) {
      const path = join(this.dir(), `${this.unit(id)}.${ext}`);
      if ((await readFile(path, "utf8").catch(() => "")).startsWith(MARKER)) await rm(path, { force: true });
    }
    await this.deps.run("systemctl", ["--user", "daemon-reload"]).catch(() => {});
    await this.deps.setup.update({ schedules: this.deps.config.schedules.filter((s) => s.id !== id) });
    return this.list();
  }

  /** Called by the timer through the CLI. Starts the lane like New lane does; nothing merges on its own. */
  async runNow(id: string): Promise<Lane> {
    const s = this.deps.config.schedules.find((x) => x.id === id);
    if (!s) throw new NotFound("no such schedule");
    return this.deps.lanes.start({ project: s.project, task: s.task, agent: s.agent, model: s.model, mode: s.mode, base: s.base, goal: `Scheduled: ${s.id}` });
  }
}
