import type { Service } from '../config.js';
export interface Unit { name: string; marker: string; serviceId: string; port: number; readiness: Service['readiness']; invocation: string | null }
export interface UnitState { state: string; marker: string; cgroup: string; invocation: string }
export interface Preview { hostname: string; port: number; upstream: string; label: string }
export interface Listener { address: string; port: number; pid: number | null; cwd: string | null; cgroup: string | null; process?: {name:string;pid:number;startedAt?:string} }
export interface AgentObservation { id: string; name: 'Codex' | 'Claude Code'; cwd: string; pid?: number; startedAt?: string }
export interface LogPage { lines: string[]; nextCursor: string | null; truncated: boolean }
export interface Host {
  bootId(): Promise<string>;
  capabilities(services: Service[]): Promise<void>;
  listeners(): Promise<Listener[]>;
  agents(): Promise<{ agents: AgentObservation[]; warnings: string[] }>;
  inspectUnit(name: string): Promise<UnitState | null>;
  startUnit(unit: Unit, service: Service): Promise<void>;
  stopUnit(unit: Unit): Promise<void>;
  ready(unit: Unit): Promise<boolean>;
  guardedRoutes(): Promise<boolean>;
  probe(url: string, readiness: Service['readiness']): Promise<boolean>;
  routes(): Promise<unknown>;
  routeState(config: unknown, route: Preview): 'absent' | 'matching' | 'conflict';
  addRoute(route: Preview): Promise<void>;
  removeRoute(route: Preview): Promise<void>;
  logs(unit: Unit, cursor: string | undefined, limit: number, redact?: (value:string)=>string): Promise<LogPage>;
  connection(): Promise<{ status: 'connected' | 'unavailable'; hostname: string | null }>;
}
