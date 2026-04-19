import type { Task, TaskStatus } from "./db.js";
import { LETAGENTS_LEASE_CHECK_NAME } from "./github-lease-enforcement.js";
import {
  normalizeTaskWorkflowArtifacts,
  type RepoCheckRunEvent,
  type TaskWorkflowArtifact,
} from "./repo-workflow.js";

const REOPENABLE_FAILED_CHECK_RUN_TASK_STATUSES = new Set<TaskStatus>([
  "merged",
  "done",
  "cancelled",
]);

export function isFailedCheckRunEvent(event: RepoCheckRunEvent): boolean {
  return (
    event.action === "completed" &&
    event.checkRun.conclusion === "failure" &&
    event.checkRun.name.trim().toLowerCase() !== LETAGENTS_LEASE_CHECK_NAME
  );
}

export function buildFailedCheckRunTaskTitle(event: RepoCheckRunEvent): string {
  return `Fix CI: ${event.checkRun.name}`;
}

export function buildFailedCheckRunTaskDescription(event: RepoCheckRunEvent): string {
  const lines = [
    `Auto-created from a failed GitHub check run in ${event.repositoryFullName}.`,
    `Check: ${event.checkRun.name}`,
    `Conclusion: ${event.checkRun.conclusion ?? event.checkRun.status}`,
    `URL: ${event.checkRun.url}`,
  ];

  if (event.checkRun.appName) {
    lines.push(`App: ${event.checkRun.appName}`);
  }

  return lines.join("\n");
}

export function buildFailedCheckRunTaskWorkflowArtifacts(
  event: RepoCheckRunEvent
): TaskWorkflowArtifact[] {
  const artifacts: TaskWorkflowArtifact[] = [];

  if (event.checkRun.suiteId !== undefined && event.checkRun.suiteId !== null) {
    artifacts.push({
      provider: event.provider,
      kind: "check_run",
      number: event.checkRun.suiteId,
      title: event.checkRun.name,
      state: event.checkRun.conclusion ?? event.checkRun.status,
    });
  }

  artifacts.push({
    provider: event.provider,
    kind: "check_run",
    id: event.checkRun.id,
    title: event.checkRun.name,
    url: event.checkRun.url,
    state: event.checkRun.conclusion ?? event.checkRun.status,
  });

  return artifacts;
}

export function mergeFailedCheckRunTaskWorkflowArtifacts(
  existingArtifacts: TaskWorkflowArtifact[],
  event: RepoCheckRunEvent
): TaskWorkflowArtifact[] {
  return normalizeTaskWorkflowArtifacts({
    artifacts: [
      ...existingArtifacts,
      ...buildFailedCheckRunTaskWorkflowArtifacts(event),
    ],
  });
}

export function shouldReopenTaskForFailedCheckRun(task: Task): boolean {
  return REOPENABLE_FAILED_CHECK_RUN_TASK_STATUSES.has(task.status);
}
