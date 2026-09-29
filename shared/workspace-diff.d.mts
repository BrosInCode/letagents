import type { WorkspaceChangedFile } from './workspace-change-summary.mjs';
export type WorkspaceDiffLine = { text: string; kind: 'context' | 'added' | 'deleted' | 'hunk' | 'metadata'; before: number | null; after: number | null };
export type WorkspaceDiffPageLine = WorkspaceDiffLine & { textLength: number; textOffset: number; nextTextOffset: number | null };
export type WorkspaceDiffPage = { lines: WorkspaceDiffPageLine[]; nextOffset: number | null; included: boolean };
export type WorkspaceDiffPageOptions = { offset?: number; textOffset?: number; singleLine?: boolean };
export type WorkspaceDiffIndex = { patch: string; files: Map<string, { end: number; checkpoints: { position: number; before: number; after: number }[] }> };
export function createWorkspaceDiffIndex(patch: string, files: WorkspaceChangedFile[]): WorkspaceDiffIndex;
export function readWorkspaceDiffPage(index: WorkspaceDiffIndex, path: string, options?: WorkspaceDiffPageOptions): WorkspaceDiffPage;
export function workspaceFilePatches(patch: string, files: WorkspaceChangedFile[], window?: { offset: number; limit: number }): Map<string, WorkspaceDiffLine[]>;
