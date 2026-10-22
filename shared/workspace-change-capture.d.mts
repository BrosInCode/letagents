import type { WorkspaceChangeSummary } from './workspace-change-summary.mjs';
export const GIT_TIMEOUT_MS: number;
export const WORKSPACE_CAPTURE_TIMEOUT_MS: number;
export const WORKSPACE_SETTLE_TIMEOUT_MS: number;
export function captureWorkspaceChanges(workspace: string, startingRevision: string | null, settledTree?: string | null, fullReview?: boolean, deadline?: AbortSignal): Promise<WorkspaceChangeSummary>;
