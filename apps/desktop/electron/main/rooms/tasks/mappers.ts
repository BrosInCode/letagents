import type { DesktopTaskSummary } from "../../../ipc-types.js";

export type DesktopTaskSummaryPayload = {
  id: string;
  title?: string;
  description?: string | null;
  status?: string;
  assignee?: string | null;
  assignee_agent_key?: string | null;
  created_by?: string | null;
  pr_url?: string | null;
  workflow_artifacts?: Array<{
    provider?: string | null;
    kind?: string | null;
    id?: string | null;
    number?: number | null;
    title?: string | null;
    url?: string | null;
    ref?: string | null;
    state?: string | null;
  }> | null;
  workflow_refs?: Array<{
    provider?: string;
    kind?: string;
    label?: string;
    url?: string;
  }> | null;
  active_leases?: Array<{
    id?: string;
    kind?: string;
    holder_label?: string | null;
    agent_label?: string | null;
    agent_key?: string | null;
    agent_session_id?: string | null;
    status?: string;
    updated_at?: string | null;
  }> | null;
  active_locks?: Array<{
    id?: string;
    scope?: string;
    reason?: string | null;
    message?: string | null;
    created_by?: string | null;
  }> | null;
  stale_prompt_state?: {
    is_stale?: boolean | null;
    reason?: string | null;
    stale_for_ms?: number | null;
    muted?: boolean | null;
    muted_by?: string | null;
    muted_at?: string | null;
  } | null;
  created_at?: string | null;
  updated_at?: string;
  updatedAt?: string;
};

export function mapDesktopTaskSummaryPayload(
  task: DesktopTaskSummaryPayload,
): DesktopTaskSummary {
  return {
    id: task.id,
    title: task.title || task.id,
    description: task.description || null,
    status: task.status || "proposed",
    assignee: task.assignee || null,
    assigneeAgentKey: task.assignee_agent_key || null,
    createdBy: task.created_by || null,
    prUrl: task.pr_url || null,
    workflowArtifacts: (task.workflow_artifacts || []).map((artifact) => ({
      provider: artifact.provider || "unknown",
      kind: artifact.kind || "artifact",
      id: artifact.id || null,
      number: artifact.number ?? null,
      title: artifact.title || null,
      url: artifact.url || null,
      ref: artifact.ref || null,
      state: artifact.state || null,
    })),
    workflowRefs: (task.workflow_refs || [])
      .map((ref) => ({
        provider: ref.provider || "unknown",
        kind: ref.kind || "artifact",
        label: ref.label || ref.url || "Workflow",
        url: ref.url || "",
      }))
      .filter((ref) => Boolean(ref.url)),
    activeLeases: (task.active_leases || [])
      .map((lease) => ({
        id: lease.id || "",
        kind: lease.kind || "work",
        holderLabel: lease.holder_label || lease.agent_label || null,
        agentKey: lease.agent_key || null,
        agentSessionId: lease.agent_session_id || null,
        status: lease.status || "active",
        updatedAt: lease.updated_at || null,
      }))
      .filter((lease) => Boolean(lease.id)),
    activeLocks: (task.active_locks || [])
      .map((lock) => ({
        id: lock.id || "",
        scope: lock.scope || "task",
        reason: lock.reason || null,
        message: lock.message || null,
        createdBy: lock.created_by || null,
      }))
      .filter((lock) => Boolean(lock.id)),
    stalePromptState: task.stale_prompt_state
      ? {
          isStale: Boolean(task.stale_prompt_state.is_stale),
          reason: task.stale_prompt_state.reason || null,
          staleForMs: task.stale_prompt_state.stale_for_ms ?? null,
          muted: Boolean(task.stale_prompt_state.muted),
          mutedBy: task.stale_prompt_state.muted_by || null,
          mutedAt: task.stale_prompt_state.muted_at || null,
        }
      : null,
    createdAt: task.created_at || null,
    updatedAt: task.updated_at || task.updatedAt || new Date().toISOString(),
  };
}
