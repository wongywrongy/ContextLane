#!/usr/bin/env node
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { backupDatabase } from "./backup.js";

const { paths } = loadConfig();
if (!await backupDatabase(join(paths.data, "contextlanes.sqlite"), join(paths.data, "backups", "nightly"), "nightly", 7)) {
  throw new Error("The database does not exist yet; no backup was made.");
}
