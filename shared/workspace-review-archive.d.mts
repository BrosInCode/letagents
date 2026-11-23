export type ReviewArchiveReference = { size: number; key: Buffer };
export function reviewArchiveReference(value: unknown): ReviewArchiveReference | null;
export function archiveWorkspaceReview(databasePath: string, data: string, digest: string): string;
export function readArchivedReviewPage(databasePath: string, reference: ReviewArchiveReference, digest: string, index: number): string;
export function readArchivedReview(databasePath: string, reference: ReviewArchiveReference, digest: string): string;
export function pruneUnreferencedReviewArchives(databasePath: string, references: Iterable<{ data?: unknown }>): void;
