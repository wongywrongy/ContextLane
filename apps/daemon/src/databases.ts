import { createHash } from "node:crypto";
import { copyFileInside } from "./safefs.js";
import { join } from "node:path";
import type { LaneDatabase, RecipeDatabase } from "@contextlanes/protocol";
import type { Config } from "./config.js";
import { Refused } from "./lanes/manager.js";
import type { Runner } from "./run.js";

/** `<template>_<project>_<nn>`, at most 63 characters, lowercase letters, digits and underscores. */
export function laneDatabaseName(template: string, laneId: string): string {
  const plain = `${template}_${laneId.replaceAll("/", "_")}`.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/_+/g, "_");
  const name = /^[a-z_]/.test(plain) ? plain : `db_${plain}`;
  // Truncating only the template collides for long project names or related templates. Keep a
  // digest of both inputs, including a disposable baseline's random identity, when shortening.
  return name.length <= 63 ? name : `${name.slice(0, 46)}_${createHash("sha256").update(JSON.stringify([template, laneId])).digest("hex").slice(0, 16)}`;
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
export async function createLaneDatabase(run: Runner, config: Config, db: RecipeDatabase, lane: { id: string; worktree: string }, projectPath: string, options: { reuse?: boolean } = {}): Promise<LaneDatabase> {
  if (db.kind === "sqlite") {
    const copied = await copyFileInside(projectPath, lane.worktree, db.file).catch((err: NodeJS.ErrnoException) => { if (err.code !== "EEXIST") throw err; return true; });
    if (!copied) throw new Refused(`The recipe's database file ${db.file} is not a regular file in the main checkout.`);
    return { kind: "sqlite", name: db.file, template: null };
  }
  const pg = postgres(config);
  const name = laneDatabaseName(db.template, lane.id);
  const exists = await psql(run, pg.admin, `SELECT 1 FROM pg_database WHERE datname = '${name}'`);
  if (exists && options.reuse === false) throw new Refused(`The temporary database ${name} already exists; it was left unchanged.`);
  if (!exists) {
    await psql(run, pg.admin, `CREATE DATABASE "${name}" TEMPLATE "${db.template}" OWNER "${pg.role}"`).catch((err: { stderr?: string; message?: string }) => {
      const detail = String(err.stderr ?? err.message ?? "").trim().split("\n").at(-1) ?? "";
      if (/being accessed by other users/.test(detail)) throw new Refused(`Postgres could not copy ${db.template} because something is connected to it. Stop what uses ${db.template}, then start the environment again.`);
      if (/must be able to SET ROLE|must be member of role/.test(detail)) throw new Refused(`Postgres could not make ${pg.role} the owner of ${name}. Run GRANT ${pg.role} TO <admin login> once, then start the environment again.`);
      throw new Refused(`Postgres could not create ${name}. ${detail}`);
    });
    // A copy keeps the template's table owners. Hand what the admin login owns to the app login, so the
    // lane can use and migrate its own tables without the admin's privileges.
    try { await psql(run, pg.admin, `REASSIGN OWNED BY CURRENT_USER TO "${pg.role}"`, name); }
    catch (err) {
      // Creation succeeded but setup did not: only remove the database created by this call.
      try { await psql(run, pg.admin, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); }
      catch (cleanup) { throw new AggregateError([err, cleanup], `Database initialization failed, and ${name} could not be removed.`); }
      throw err;
    }
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
