import type { SqliteRoutingDatabase } from "./sqlite-thread-routing.mjs";
import type { LocalWorkLeaseAction } from "./local-work-leases.mjs";
export type LocalTask = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  assignee: string | null;
  assignee_agent_key: string | null;
  assignee_agent_instance_id: string | null;
  assignee_agent_session_id: string | null;
  created_by: string | null;
  pr_url: string | null;
  workflow_artifacts: Array<Record<string, unknown>>;
  workflow_refs: Array<Record<string, unknown>>;
  active_leases?: Array<{
    id: string;
    kind: "review" | string;
    holder_label: string | null;
    agent_key: string | null;
    agent_session_id: string | null;
    status: string;
    updated_at: string | null;
  }>;
  created_at: string;
  updated_at: string;
};

export type LocalTaskStore = {
  addLocalTask(roomId: string, input: { title: string; description?: string | null; created_by?: string | null }): Promise<LocalTask>;
  updateLocalTask(roomId: string, taskId: string, patch: Record<string, unknown>): Promise<LocalTask>;
  getLocalTask(roomId: string, taskId: string): Promise<LocalTask | null>;
  listLocalTasks(roomId: string, options?: { status?: string | null; openOnly?: boolean }): Promise<{ tasks: LocalTask[]; has_more: boolean }>;
  listLocalActiveTaskOwnerLeases(roomId: string): Promise<Array<{ kind: "work"; status: "active"; actor_label: string; agent_key: string; agent_instance_id: string | null; agent_session_id: string | null }>>;
  changeLocalTaskWorkLease(roomId: string, taskId: string, input: LocalWorkLeaseAction): Promise<{ action: string; task: LocalTask; released_lease: Record<string, unknown>; new_lease: Record<string, unknown> | null }>;
  claimLocalTaskReviewLease(roomId: string, taskId: string, input: { holder_label?: string | null; agent_key?: string | null; agent_session_id?: string | null }): Promise<{ task: LocalTask; lease: NonNullable<LocalTask["active_leases"]>[number] }>;
  releaseLocalTaskReviewLease(roomId: string, taskId: string, input?: { lease_id?: string | null }): Promise<{ task: LocalTask; released_lease: NonNullable<LocalTask["active_leases"]>[number] | null }>;
};
export function createLocalTaskStore(dependencies: {
  getDb(): Promise<SqliteRoutingDatabase>;
  withWorkerStateFence<T>(callback: () => T): T;
  currentWorkerCall(): { agent_key?: string | null; session_id: string; actor_label?: string | null; agent_instance_id?: string | null } | null | undefined;
}): LocalTaskStore;
