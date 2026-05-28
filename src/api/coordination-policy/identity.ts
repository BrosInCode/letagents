import {
  normalizeTaskWorkflowArtifacts,
  type TaskWorkflowArtifact,
} from "../repo-workflow.js";
import type {
  CoordinationLeaseLike,
  CoordinationTaskLike,
  CoordinationWorkIntent,
} from "./types.js";

export function normalizeIdentity(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function normalizeUrlIdentity(value: string | null | undefined): string | null {
  const normalized = normalizeIdentity(value);
  return normalized ? normalized.replace(/\/+$/, "") : null;
}

export function isOpenCoordinationTask(task: CoordinationTaskLike): boolean {
  return task.status !== "done" && task.status !== "cancelled";
}

export function taskWorkflowArtifacts(
  task: CoordinationTaskLike
): TaskWorkflowArtifact[] {
  return normalizeTaskWorkflowArtifacts({
    artifacts: task.workflow_artifacts ? [...task.workflow_artifacts] : [],
    prUrl: task.pr_url ?? null,
  });
}

export function intentWorkflowArtifacts(intent: CoordinationWorkIntent): TaskWorkflowArtifact[] {
  return normalizeTaskWorkflowArtifacts({
    artifacts: intent.workflowArtifacts ? [...intent.workflowArtifacts] : [],
    prUrl: intent.prUrl ?? null,
  });
}

export function leaseWorkflowArtifacts(lease: CoordinationLeaseLike): TaskWorkflowArtifact[] {
  return normalizeTaskWorkflowArtifacts({
    artifacts: [],
    prUrl: lease.pr_url ?? null,
  });
}

function artifactIdentityValues(artifact: TaskWorkflowArtifact): string[] {
  const values: string[] = [];
  const url = normalizeUrlIdentity(artifact.url);
  if (url) {
    values.push(`url:${url}`);
  }
  if (artifact.id) {
    values.push(`${artifact.provider}:${artifact.kind}:id:${artifact.id}`);
  }
  if (artifact.number !== undefined && artifact.number !== null) {
    values.push(`${artifact.provider}:${artifact.kind}:number:${artifact.number}`);
  }
  if (artifact.ref) {
    values.push(`${artifact.provider}:${artifact.kind}:ref:${artifact.ref}`);
  }
  return values;
}

export function artifactsShareIdentity(
  left: TaskWorkflowArtifact,
  right: TaskWorkflowArtifact
): string | null {
  const rightValues = new Set(artifactIdentityValues(right));
  return artifactIdentityValues(left).find((value) => rightValues.has(value)) ?? null;
}
