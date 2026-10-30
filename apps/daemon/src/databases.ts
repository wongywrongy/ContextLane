import { constants as fsConstants } from "node:fs";
import { copyFile, lstat, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LaneDatabase, RecipeDatabase } from "@contextlanes/protocol";
import type { Config } from "./config.js";
import { Refused } from "./lanes/manager.js";
import type { Runner } from "./run.js";

/** `<template>_<project>_<nn>`, at most 63 characters, lowercase letters, digits and underscores. */
export function laneDatabaseName(template: string, laneId: string): string {
  const [project, n] = laneId.split("/");
  const tail = `_${(project ?? "lane").replace(/[^a-z0-9]+/g, "_")}_${n ?? "00"}`;
  return `${template.slice(0, 63 - tail.length)}${tail}`.replace(/_+/g, "_");
}

/** libpq reads these; passing the URL as an argument would show its password in the process list. */
export function pgEnv(url: string, database?: string): Record<string, string> {
  const u = new URL(url);
  return { PGHOST: decodeURIComponent(u.hostname || "localhost"), PGPORT: u.port || "5432", PGUSER: decodeURIComponent(u.username), PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: database ?? (decodeURIComponent(u.pathname.slice(1)) || "postgres"), PGCONNECT_TIMEOUT: "10" };
}

function postgres(config: Config) {
  const pg = config.databases.postgres;
  if (!pg) throw new Refused("This recipe asks for a Postgres database per lane. Add [databases.postgres] with admin and app logins to ~/.config/contextlanes/config.toml first.");
  const role = decodeURIComponent(new URL(pg.app).username);
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(role)) throw new Refused("The app login in [databases.postgres] needs a plain user name.");
  return { ...pg, role };
}

async function psql(run: Runner, admin: string, sql: string, database?: string): Promise<string> {
  return (await run("psql", ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql], { env: pgEnv(admin, database), timeout: 300_000 })).stdout.trim();
}

/** Create the lane's copy (or keep one made before) and return what setup steps and services get. */
export async function createLaneDatabase(run: Runner, config: Config, db: RecipeDatabase, lane: { id: string; worktree: string }, projectPath: string): Promise<LaneDatabase> {
  if (db.kind === "sqlite") {
    const source = join(projectPath, db.file);
    if (!(await lstat(source).then((s) => s.isFile(), () => false))) throw new Refused(`The recipe's database file ${db.file} is not in the main checkout.`);
    const target = join(lane.worktree, db.file);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target, fsConstants.COPYFILE_EXCL).catch((err: NodeJS.ErrnoException) => { if (err.code !== "EEXIST") throw err; });
    return { kind: "sqlite", name: db.file, template: null };
  }
  const pg = postgres(config);
  const name = laneDatabaseName(db.template, lane.id);
  const exists = await psql(run, pg.admin, `SELECT 1 FROM pg_database WHERE datname = '${name}'`);
  if (!exists) {
    await psql(run, pg.admin, `CREATE DATABASE "${name}" TEMPLATE "${db.template}" OWNER "${pg.role}"`).catch((err: { stderr?: string; message?: string }) => {
      const detail = String(err.stderr ?? err.message ?? "").trim().split("\n").at(-1) ?? "";
      if (/being accessed by other users/.test(detail)) throw new Refused(`Postgres could not copy ${db.template} because something is connected to it. Stop what uses ${db.template}, then start the environment again.`);
      if (/must be able to SET ROLE|must be member of role/.test(detail)) throw new Refused(`Postgres could not make ${pg.role} the owner of ${name}. Run GRANT ${pg.role} TO <admin login> once, then start the environment again.`);
      throw new Refused(`Postgres could not create ${name}. ${detail}`);
    });
    // A copy keeps the template's table owners. Hand what the admin login owns to the app login, so the
    // lane can use and migrate its own tables without the admin's privileges.
    await psql(run, pg.admin, `REASSIGN OWNED BY CURRENT_USER TO "${pg.role}"`, name);
  }
  return { kind: "postgres", name, template: db.template };
}

/** The variable setup steps and services get: a non-admin URL for Postgres, the copy's path for SQLite. */
export function databaseEnv(config: Config, db: RecipeDatabase, made: LaneDatabase, worktree: string): Record<string, string> {
  if (made.kind === "sqlite") return { [db.env]: join(worktree, made.name) };
  const url = new URL(postgres(config).app);
  url.pathname = `/${made.name}`;
  return { [db.env]: url.toString() };
}

/** Clean up drops the copy; a SQLite copy goes with the worktree. */
export async function dropLaneDatabase(run: Runner, config: Config, made: LaneDatabase): Promise<void> {
  if (made.kind !== "postgres") return;
  await psql(run, postgres(config).admin, `DROP DATABASE IF EXISTS "${made.name}" WITH (FORCE)`);
}
