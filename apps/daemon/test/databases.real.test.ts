import { describe, expect, it } from "vitest";
import { Config, runCommand } from "@contextlanes/daemon";
import { createLaneDatabase, databaseEnv, dropLaneDatabase, pgEnv } from "../src/databases.js";

// CONTEXTLANES_REAL_POSTGRES="<admin url> <app url>"; the admin login needs CREATEDB and membership in the
// app login's role, and a template database named shop_dev with a table invoices must exist.
const urls = process.env.CONTEXTLANES_REAL_POSTGRES?.split(" ");

describe.skipIf(!urls)("per-lane Postgres against a real server", () => {
  it("copies the template, lets only the app login use it, and drops it", async () => {
    const [admin, app] = urls!;
    const config = Config.parse({ databases: { postgres: { admin, app } } });
    const db = { kind: "postgres" as const, template: "shop_dev", env: "DATABASE_URL" };
    const made = await createLaneDatabase(runCommand, config, db, { id: "shop/07", worktree: "/tmp" }, "/tmp");
    expect(made.name).toBe("shop_dev_shop_07");
    expect(await createLaneDatabase(runCommand, config, db, { id: "shop/07", worktree: "/tmp" }, "/tmp")).toEqual(made); // a second start keeps the copy
    const url = databaseEnv(config, db, made, "/tmp").DATABASE_URL!;
    const asApp = (sql: string) => runCommand("psql", ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql], { env: pgEnv(url) }).then((r) => r.stdout.trim());
    expect(await asApp("SELECT total FROM invoices WHERE id = 1")).toBe("42");
    expect(await asApp("ALTER TABLE invoices ADD COLUMN status text; SELECT current_user")).toBe("shop_app");
    await expect(asApp("CREATE DATABASE escape_attempt")).rejects.toThrow(/permission denied/);
    await dropLaneDatabase(runCommand, config, made);
    await expect(asApp("SELECT 1")).rejects.toThrow(/does not exist/);
  });
});
