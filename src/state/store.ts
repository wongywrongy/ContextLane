import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Profile } from '../config.js';
import { revision } from '../config.js';
import { Problem, type Operation } from '../shared/contracts.js';
import type { Unit, Preview } from '../host/types.js';

export interface EnvironmentRow { id: string; revision: string; observation: string; desired: 'running' | 'stopped' }
export interface Resource { id: string; environment: string; operation: string; kind: 'unit' | 'route'; data: string; attempted: number; removed: number; ordinal: number }
export type Observation = { projectPath: string; effects: string; dataRequirements: string; services: { id: string; port: number; readiness: Profile['services'][number]['readiness'] }[]; previews: Profile['previews'] };
const migrations = ['001_initial.sql'];
export class Store {
  readonly db: Database.Database;
  readonly installation: string;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('foreign_keys = ON'); this.db.pragma('busy_timeout = 3000'); this.db.pragma('journal_mode = WAL');
    const version = this.db.pragma('user_version', { simple: true }) as number;
    if (version > migrations.length) throw new Problem('STATE_VERSION', 'Database is newer than this Rootlane build');
    for (let i = version; i < migrations.length; i++) this.db.transaction(() => { this.db.exec(readFileSync(new URL(`./migrations/${migrations[i]}`, import.meta.url), 'utf8')); this.db.pragma(`user_version = ${i + 1}`); })();
    this.db.prepare('INSERT OR IGNORE INTO meta VALUES (?, ?)').run('installation', randomUUID());
    this.installation = this.meta('installation')!;
  }
  meta(key: string) { return (this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string } | undefined)?.value; }
  setMeta(key: string, value: string) { this.db.prepare('INSERT INTO meta VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
  environment(id: string) { return this.db.prepare('SELECT * FROM environments WHERE id=?').get(id) as EnvironmentRow | undefined; }
  environments() { return this.db.prepare('SELECT * FROM environments ORDER BY id').all() as EnvironmentRow[]; }
  ensure(profile: Profile) {
    this.db.prepare('INSERT OR IGNORE INTO environments VALUES (?, ?, ?, ?)').run(profile.id, revision(profile), this.observation(profile), 'stopped');
  }
  observation(profile: Profile) { return JSON.stringify({ projectPath: profile.projectPath, effects: profile.effects, dataRequirements: profile.dataRequirements, services: profile.services.map(({ id, port, readiness }) => ({ id, port, readiness })), previews: profile.previews } satisfies Observation); }
  getOperation(id: string): Operation {
    const row = this.db.prepare('SELECT * FROM operations WHERE id=?').get(id) as Omit<Operation, 'error'> & { error: string | null };
    return { ...row, error: row.error ? JSON.parse(row.error) : null };
  }
  latest(id: string) {
    const row = this.db.prepare('SELECT id FROM operations WHERE environmentId=? ORDER BY rowid DESC LIMIT 1').get(id) as { id: string } | undefined;
    return row ? this.getOperation(row.id) : null;
  }
  retry(environmentId: string, action: 'start' | 'stop', requestId: string) {
    const prior = this.db.prepare('SELECT * FROM requests WHERE id=?').get(requestId) as { payload: string; operation: string } | undefined;
    if (!prior) return null;
    if (prior.payload !== JSON.stringify({ environmentId, action })) throw new Problem('REQUEST_ID_REUSED', 'requestId already belongs to another action');
    return this.getOperation(prior.operation);
  }
  accept(environmentId: string, action: 'start' | 'stop', requestId: string): { operation: Operation; fresh: boolean } {
    return this.db.transaction(() => {
      const payload = JSON.stringify({ environmentId, action });
      const prior = this.retry(environmentId, action, requestId);
      if (prior) return { operation: prior, fresh: false };
      const active = this.db.prepare("SELECT id, action FROM operations WHERE environmentId=? AND status IN ('accepted','running')").get(environmentId) as { id: string; action: string } | undefined;
      if (active && active.action !== action) throw new Problem('OPERATION_IN_PROGRESS', `Wait for operation ${active.id}`);
      const opId = active?.id ?? randomUUID();
      if (!active) this.db.prepare('INSERT INTO operations VALUES (?, ?, ?, ?, NULL, ?, NULL)').run(opId, environmentId, action, 'accepted', new Date().toISOString());
      this.db.prepare('INSERT INTO requests VALUES (?, ?, ?)').run(requestId, payload, opId);
      this.db.prepare('UPDATE environments SET desired=? WHERE id=?').run(action === 'start' ? 'running' : 'stopped', environmentId);
      return { operation: this.getOperation(opId), fresh: !active };
    }).immediate();
  }
  finish(id: string, status: Operation['status'], error: Operation['error'] = null) {
    this.db.prepare('UPDATE operations SET status=?, error=?, finishedAt=? WHERE id=?').run(status, error ? JSON.stringify(error) : null, ['accepted', 'running'].includes(status) ? null : new Date().toISOString(), id);
  }
  resources(environment: string, includeRemoved = false) {
    return this.db.prepare(`SELECT * FROM resources WHERE environment=? ${includeRemoved ? '' : 'AND removed=0'} ORDER BY ${includeRemoved ? 'rowid' : 'ordinal, rowid'}`).all(environment) as Resource[];
  }
  reserve(profile: Profile, opId: string, items: { kind: Resource['kind']; data: Unit | Preview; keys: string[] }[]) {
    this.db.transaction(() => {
      if (this.resources(profile.id).length) throw new Problem('NEEDS_STOP', 'Stop the existing environment before replacing its resources');
      this.db.prepare('UPDATE environments SET revision=?, observation=? WHERE id=?').run(revision(profile), this.observation(profile), profile.id);
      items.forEach((item, ordinal) => {
        const id = randomUUID();
        this.db.prepare('INSERT INTO resources (id, environment, operation, kind, data, ordinal) VALUES (?, ?, ?, ?, ?, ?)').run(id, profile.id, opId, item.kind, JSON.stringify(item.data), ordinal);
        for (const key of item.keys) {
          const conflict = this.db.prepare('SELECT r.environment FROM reservations v JOIN resources r ON r.id=v.resource WHERE v.key=?').get(key) as { environment: string } | undefined;
          if (conflict) throw new Problem('RESOURCE_CONFLICT', `${key} is reserved by ${conflict.environment}`);
          this.db.prepare('INSERT INTO reservations VALUES (?, ?)').run(key, id);
        }
      });
    }).immediate();
  }
  attempted(id: string, value = 1) { this.db.prepare('UPDATE resources SET attempted=? WHERE id=?').run(value, id); }
  updateData(id: string, data: Unit) { this.db.prepare('UPDATE resources SET data=? WHERE id=?').run(JSON.stringify(data), id); }
  release(id: string) { this.db.transaction(() => { this.db.prepare('DELETE FROM reservations WHERE resource=?').run(id); this.db.prepare('UPDATE resources SET removed=1 WHERE id=?').run(id); })(); }
  saveLogs(id: string, lines: string[]) { this.db.prepare('INSERT INTO failure_logs VALUES (?, ?) ON CONFLICT(resource) DO UPDATE SET lines=excluded.lines').run(id, JSON.stringify(lines.slice(-100).map(l => l.slice(0, 2048)))); }
  savedLogs(id: string): string[] { const row = this.db.prepare('SELECT lines FROM failure_logs WHERE resource=?').get(id) as { lines: string } | undefined; return row ? JSON.parse(row.lines) : []; }
  close() { this.db.close(); }
}
