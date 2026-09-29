import type { SqliteRoutingDatabase as SqliteDatabase } from './sqlite-thread-routing.mjs';
export type LocalWorkLeaseWorker = {
  agent_key: string; session_id: string; actor_label: string; agent_instance_id?: string | null; supervised?: boolean;
};
export type LocalWorkLease = {
  id: string; room_id: string; task_id: string; kind: 'work'; status: string;
  agent_key: string; agent_session_id: string; agent_instance_id: string | null; actor_label: string;
  epoch: number; created_at: string; updated_at: string; last_heartbeat_at: string;
  expires_at: string | null; revoked_reason: string | null;
};
export type LocalWorkLeaseAction = {
  action: 'release' | 'handoff'; lease_id?: string | null; epoch?: number;
  target_actor_key?: string | null; target_actor_instance_id?: string | null; target_agent_session_id?: string | null;
};
export function ensureLocalWorkLeaseSchema(db: SqliteDatabase): void;
export function readLocalWorkLeases(db: SqliteDatabase, roomId: string, taskId: string): LocalWorkLease[];
export function assertLocalWorkLeaseWorker(db: SqliteDatabase, roomId: string, worker: LocalWorkLeaseWorker): boolean;
export function claimLocalWorkLease(db: SqliteDatabase, roomId: string, taskId: string, worker: LocalWorkLeaseWorker): LocalWorkLease;
export function assertLocalTaskLeaseMutation(db: SqliteDatabase, task: Record<string, unknown>, worker: LocalWorkLeaseWorker,
  expected?: Pick<LocalWorkLease, 'id' | 'epoch'> | null): void;
export function changeLocalWorkLease(db: SqliteDatabase, roomId: string, taskId: string, input: LocalWorkLeaseAction,
  worker: LocalWorkLeaseWorker | null): { released_lease: LocalWorkLease; new_lease: LocalWorkLease | null };
export function endLocalWorkerLeases(db: SqliteDatabase, sessionId: string, now: string): void;
export function heartbeatLocalWorkLeases(db: SqliteDatabase, sessionId: string, now: string): Array<{id: string; epoch: number}>;
