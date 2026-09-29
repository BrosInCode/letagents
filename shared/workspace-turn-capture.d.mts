import type { WorkspaceChangeSummary } from './workspace-change-summary.mjs';
import type { WorkspaceReview } from './workspace-review.mjs';
export function unavailableWorkspace(): WorkspaceChangeSummary;
export function captureWorkspaceTree(workspace: string, identity: string): Promise<string | null>;
export function releaseWorkspaceTree(workspace: string, identity: string): Promise<void>;
export function captureWorkspacePair(workspace: string, startingRevision: string | null, baseline: string | null, identity: string): Promise<{
  workspace: WorkspaceChangeSummary;
  contribution: { changes: WorkspaceChangeSummary; summary: string | null };
  review: WorkspaceReview;
}>;
