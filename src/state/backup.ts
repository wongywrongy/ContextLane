import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { open } from 'node:fs/promises';
process.umask(0o077);
const [source, destination] = process.argv.slice(2);
if (!source || !destination || resolve(source) === resolve(destination)) throw new Error('Usage: npm run backup -- /absolute/state/rootlane.sqlite /absolute/backup.sqlite');
const file = await open(destination, 'wx', 0o600); await file.close();
const db = new Database(source, { readonly: true, fileMustExist: true });
try { await db.backup(destination); } finally { db.close(); }
