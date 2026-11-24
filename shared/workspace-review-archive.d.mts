export class InvalidInlineReviewError extends Error {}
export type ReviewArchiveReference = { size: number; key: Buffer };
export function reviewArchiveReference(value: unknown): ReviewArchiveReference | null;
export function verifyWorkspaceReviewRecoverySet(databasePath: string, database: import('node:sqlite').DatabaseSync): void;
export function archiveWorkspaceReview(databasePath: string, data: string, digest: string): string;
export function discardUncommittedReviewArchive(databasePath: string, value: string): void;
export function readArchivedReviewPage(databasePath: string, reference: ReviewArchiveReference, digest: string, index: number): string;
export function readArchivedReview(databasePath: string, reference: ReviewArchiveReference, digest: string): string;
export function pruneUnreferencedReviewArchives(databasePath: string, references: () => Iterable<{ data?: unknown }>): void;
