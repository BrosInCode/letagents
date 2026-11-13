import type { WorkspaceChangeSummary } from './workspace-change-summary.mjs';
export const GIT_TIMEOUT_MS: number;
export const WORKSPACE_CAPTURE_TIMEOUT_MS: number;
export const WORKSPACE_SETTLE_TIMEOUT_MS: number;
/** The options every Git command of a capture starts with: no hook, no file-system monitor program, no signature program. */
export const CAPTURE_GIT_OPTIONS: readonly string[];
/** The environment of every Git command of a capture: no caller GIT_*, no prompt, no replace refs, no lazy fetch. */
export function captureGitEnvironment(extra?: Record<string, string>): NodeJS.ProcessEnv;
export function captureWorkspaceChanges(workspace: string, startingRevision: string | null, settledTree?: string | null, fullReview?: boolean, deadline?: AbortSignal): Promise<WorkspaceChangeSummary>;
