import type { WorkspaceChangeSummary } from './workspace-change-summary.mjs';
export function captureWorkspaceChanges(workspace: string, startingRevision: string | null, settledTree?: string, fullReview?: boolean): Promise<WorkspaceChangeSummary>;
