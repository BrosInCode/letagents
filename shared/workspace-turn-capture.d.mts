import type { WorkspaceChangeSummary } from './workspace-change-summary.mjs';
import type { WorkspaceReview } from './workspace-review.mjs';
import type nodePath from 'node:path';
export function unavailableWorkspace(): WorkspaceChangeSummary;
export function escapesWorkspace(root: string, parent: string, path?: Pick<typeof nodePath, 'relative' | 'isAbsolute' | 'sep'>): boolean;
export function captureWorkspaceTree(workspace: string, identity: string, deadline?: AbortSignal): Promise<string | null>;
export function releaseWorkspaceTree(workspace: string, identity: string, timeout?: number): Promise<void>;
export function captureWorkspaceHead(workspace: string): Promise<string | null>;
/** How long the remotes get to list their branches, in milliseconds. */
export const REMOTE_QUESTION_TIMEOUT_MS: number;
/** `onNoAnswer` is told why a null is returned; by default the reason goes to stderr. `limit` replaces REMOTE_QUESTION_TIMEOUT_MS. */
export function captureRemoteTips(workspace: string, options?: { onNoAnswer?: (reason: string) => void; limit?: number }): Promise<string[] | null>;
export function captureRecordedRemoteTips(url: string | null | undefined, directory?: string, options?: { onNoAnswer?: (reason: string) => void; limit?: number }): Promise<string[] | null>;
type SettledPair = { workspace: WorkspaceChangeSummary; contribution: { changes: WorkspaceChangeSummary; summary: string | null }; review: WorkspaceReview };
/** A settled turn whose comparison still needs the remotes' answer: the settled tree stays pinned for compareSettledTurn. */
export type PendingSettledTurn = { full: WorkspaceChangeSummary; tree: string; head: string };
export function settledWorkspacePair(full: WorkspaceChangeSummary, changes: WorkspaceChangeSummary): SettledPair;
/** The first part of a settled turn. It waits for no remote. `{ pair }` is complete; `{ pending }` goes to compareSettledTurn. */
export function captureSettledWorkspace(workspace: string, startingRevision: string | null, baseline: string | null, identity: string, startingHead?: string | null, deadline?: AbortSignal): Promise<{ pair: SettledPair; pending?: undefined } | { pending: PendingSettledTurn; pair?: undefined }>;
/** The second part: the turn's own changes, with the remotes' answer. It releases the settled tree. */
export function compareSettledTurn(workspace: string, startingRevision: string | null, baseline: string, identity: string, startingHead: string, pending: Pick<PendingSettledTurn, 'tree' | 'head'>, remoteTips: readonly string[] | null, deadline?: AbortSignal): Promise<WorkspaceChangeSummary>;
export function captureWorkspacePair(workspace: string, startingRevision: string | null, baseline: string | null, identity: string, startingHead?: string | null, remoteTips?: readonly string[] | null | Promise<readonly string[] | null>): Promise<{
  workspace: WorkspaceChangeSummary;
  contribution: { changes: WorkspaceChangeSummary; summary: string | null };
  review: WorkspaceReview;
}>;
