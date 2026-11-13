import type { WorkspaceChangeSummary } from './workspace-change-summary.mjs';
import type { WorkspaceReview } from './workspace-review.mjs';
import type nodePath from 'node:path';
export function unavailableWorkspace(): WorkspaceChangeSummary;
export function escapesWorkspace(root: string, parent: string, path?: Pick<typeof nodePath, 'relative' | 'isAbsolute' | 'sep'>): boolean;
export function captureWorkspaceTree(workspace: string, identity: string, deadline?: AbortSignal): Promise<string | null>;
export function releaseWorkspaceTree(workspace: string, identity: string, timeout?: number): Promise<void>;
export function captureWorkspaceHead(workspace: string): Promise<string | null>;
/** `onNoAnswer` is told why a null is returned; by default the reason goes to stderr. */
export function captureRemoteTips(workspace: string, options?: { onNoAnswer?: (reason: string) => void }): Promise<string[] | null>;
export function captureRecordedRemoteTips(url: string | null | undefined, directory?: string, options?: { onNoAnswer?: (reason: string) => void }): Promise<string[] | null>;
/** The provider's edited paths settled against the workspace: each kept candidate and its workspace-relative path, and the turn's start. */
export type WorkspaceEditSettlement = { paths: Array<[candidate: string, path: string]>; start: { committed_at: string | null; in_history: boolean | null } | null };
/** `editCandidates` (paths as the provider gave them) asks for `editSettlement`; it is null when the paths could not be decided. */
export function captureWorkspacePair(workspace: string, startingRevision: string | null, baseline: string | null, identity: string, startingHead?: string | null, remoteTips?: readonly string[] | null | Promise<readonly string[] | null>, editCandidates?: readonly string[] | null): Promise<{
  workspace: WorkspaceChangeSummary;
  contribution: { changes: WorkspaceChangeSummary; summary: string | null };
  review: WorkspaceReview;
  editSettlement?: WorkspaceEditSettlement | null;
}>;
