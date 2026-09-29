import type { SqliteRoutingDatabase } from "./sqlite-thread-routing.mjs";
export type LocalSupervisedMessageRow = {
  room_id: string; number: number; sender: string; text: string; source: string | null;
  publisher_agent_key: string | null; thread_root_number: number | null; reply_to_number: number | null;
  control_authorized: number | null; timestamp: string; sync_key: string | null;
};
export function ensureLocalSupervisedRoutingSchema(db: SqliteRoutingDatabase): void;
export function captureLocalSupervisedRouting(db: SqliteRoutingDatabase, row: LocalSupervisedMessageRow): void;
export function runLocalSupervisedMessageWrite<T>(db: SqliteRoutingDatabase, roomId: string, threadRootNumber: number | null, work: () => T): Promise<T>;
