import type { TaskLeaseKind, TaskStatus } from "./db.js";
import type { CoordinationMutationKind } from "./coordination-policy.js";

export interface TaskCoordinationUpdatePatch {
  status?: TaskStatus;
  pr_url?: string | null;
  workflow_artifacts?: unknown;
}

export interface TaskCoordinationMutationClassification {
  mutation: CoordinationMutationKind;
  leaseKind: TaskLeaseKind;
  claim: boolean;
}

export function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

export function classifyTaskCoordinationMutation(
  updates: TaskCoordinationUpdatePatch
): TaskCoordinationMutationClassification | null {
  if (updates.status === "assigned") {
    return { mutation: "task_claim", leaseKind: "work", claim: true };
  }

  if (updates.status === "in_review") {
    return { mutation: "task_complete", leaseKind: "work", claim: false };
  }

  if (updates.pr_url !== undefined || updates.workflow_artifacts !== undefined) {
    return { mutation: "workflow_artifact_attach", leaseKind: "work", claim: false };
  }

  if (updates.status === "in_progress" || updates.status === "blocked") {
    return { mutation: "task_update", leaseKind: "work", claim: false };
  }

  return null;
}

export function getTaskUpdatePrUrlBinding(
  updates: TaskCoordinationUpdatePatch
): string | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(updates, "pr_url")) {
    return undefined;
  }

  return updates.pr_url ?? null;
}
