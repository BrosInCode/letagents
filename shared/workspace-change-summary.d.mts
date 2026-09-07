export const WORKSPACE_PATCH_LIMIT: number;
export const WORKSPACE_FILE_LIMIT: number;
export type WorkspaceChangedFile = {
  path: string;
  previous_path: string | null;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typechange' | 'untracked' | 'unknown';
  additions: number;
  deletions: number;
  binary: boolean;
};
export type WorkspaceChangeSummary = {
  captured_at: string;
  branch: string | null;
  /** Immutable workspace starting revision; includes committed work since creation. */
  base_revision: string | null;
  state: 'ready' | 'unavailable' | 'not_git';
  files: WorkspaceChangedFile[];
  additions: number;
  deletions: number;
  hidden_files: number;
  patch: string;
  patch_truncated: boolean;
};
export function parseWorkspaceChangeSummary(value: unknown): WorkspaceChangeSummary | null;
