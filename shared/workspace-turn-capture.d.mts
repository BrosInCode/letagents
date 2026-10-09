import type { WorkspaceChangeSummary } from './workspace-change-summary.mjs';
import type { WorkspaceReview } from './workspace-review.mjs';
export function unavailableWorkspace(): WorkspaceChangeSummary;
export function captureWorkspaceTree(workspace: string, identity: string): Promise<string | null>;
export function releaseWorkspaceTree(workspace: string, identity: string): Promise<void>;
export function captureWorkspaceHead(workspace: string): Promise<string | null>;
export function captureRemoteTips(workspace: string): Promise<string[] | null>;
export function captureRecordedRemoteTips(url: string | null | undefined, directory?: string): Promise<string[] | null>;
export function captureWorkspacePair(workspace: string, startingRevision: string | null, baseline: string | null, identity: string, startingHead?: string | null, remoteTips?: readonly string[] | null | Promise<readonly string[] | null>): Promise<{
  workspace: WorkspaceChangeSummary;
  contribution: { changes: WorkspaceChangeSummary; summary: string | null };
  review: WorkspaceReview;
}>;
