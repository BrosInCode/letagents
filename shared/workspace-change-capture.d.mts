import type { WorkspaceChangeSummary } from './workspace-change-summary.mjs';
export const GIT_TIMEOUT_MS: number;
export const WORKSPACE_CAPTURE_TIMEOUT_MS: number;
export const WORKSPACE_SETTLE_TIMEOUT_MS: number;
/** Options and environment of every Git command of a capture: no replace refs, grafts, commit-graph or lazy fetch. */
export const CAPTURE_GIT_OPTIONS: readonly string[];
export function captureGitEnvironment(extra?: Record<string, string>): Record<string, string | undefined>;
export function captureWorkspaceChanges(workspace: string, startingRevision: string | null, settledTree?: string | null, fullReview?: boolean, deadline?: AbortSignal): Promise<WorkspaceChangeSummary>;
