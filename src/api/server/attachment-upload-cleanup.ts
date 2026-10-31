import {
  deleteExpiredPendingMessageAttachmentUpload,
  listExpiredPendingMessageAttachmentUploads,
  type ExpiredMessageAttachmentUploadCursor,
} from "../db/messages/attachments.js";
import {
  deleteAttachmentObject,
  isAttachmentStorageConfigured,
} from "../messages/attachment-storage.js";

/** Cadence of the expired-upload sweep. Staged uploads live 15 minutes, so this only bounds leftover storage. */
export const ATTACHMENT_UPLOAD_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
/**
 * How long past its expiry an upload is kept. A send claims an upload only
 * before its expiry by the API's clock, and a presigned PUT that started just
 * before expiry may still be writing; this margin covers both.
 */
export const ATTACHMENT_UPLOAD_CLEANUP_GRACE_MS = 60 * 60 * 1000;
export const ATTACHMENT_UPLOAD_CLEANUP_BATCH = 25;
export const MAX_ATTACHMENT_UPLOAD_CLEANUP_BATCHES_PER_TICK = 4;

export interface AttachmentUploadCleanupDeps {
  now(): number;
  storageConfigured(): boolean;
  deleteObject(input: { object_key: string }, options: { signal: AbortSignal }): Promise<void>;
}

/** Where the previous tick stopped, so rows whose objects keep failing never block the rest. */
export interface AttachmentUploadCleanupState {
  cursor: ExpiredMessageAttachmentUploadCursor | null;
}

const sharedState: AttachmentUploadCleanupState = { cursor: null };
const defaultDeps: AttachmentUploadCleanupDeps = {
  now: () => Date.now(),
  storageConfigured: isAttachmentStorageConfigured,
  deleteObject: deleteAttachmentObject,
};

/**
 * Remove pending uploads that expired unclaimed (a discarded draft, a lost
 * send acknowledgement) and their stored objects, in bounded batches.
 *
 * Each object is deleted before its row, so a failed object delete keeps the
 * row and a later pass retries it. Passes walk the expired rows in order from
 * where the last tick stopped, so failing rows are retried once per pass and
 * never starve the others. Without object storage nothing is removed.
 */
export async function cleanupExpiredAttachmentUploadsOnce(
  deps: AttachmentUploadCleanupDeps = defaultDeps,
  state: AttachmentUploadCleanupState = sharedState,
  signal: AbortSignal = new AbortController().signal,
): Promise<{ deleted: number; object_failures: number }> {
  if (!deps.storageConfigured()) return { deleted: 0, object_failures: 0 };
  const expiredBefore = new Date(deps.now() - ATTACHMENT_UPLOAD_CLEANUP_GRACE_MS).toISOString();
  let deleted = 0;
  let objectFailures = 0;
  let firstFailure: unknown = null;
  try {
    for (let batch = 0; batch < MAX_ATTACHMENT_UPLOAD_CLEANUP_BATCHES_PER_TICK && !signal.aborted; batch++) {
      const uploads = await listExpiredPendingMessageAttachmentUploads({
        expired_before: expiredBefore,
        after: state.cursor,
        limit: ATTACHMENT_UPLOAD_CLEANUP_BATCH,
      });
      for (const upload of uploads) {
        if (signal.aborted) break;
        let objectDeleted = false;
        try {
          await deps.deleteObject({ object_key: upload.object_key }, { signal });
          objectDeleted = true;
        } catch (error) {
          if (signal.aborted) break;
          objectFailures += 1;
          firstFailure ??= error;
        }
        if (objectDeleted && await deleteExpiredPendingMessageAttachmentUpload({
          upload_id: upload.upload_id,
          expired_before: expiredBefore,
        })) deleted += 1;
        state.cursor = { expires_at: upload.expires_at, upload_id: upload.upload_id };
      }
      if (uploads.length < ATTACHMENT_UPLOAD_CLEANUP_BATCH && !signal.aborted) {
        state.cursor = null;
        break;
      }
    }
  } finally {
    if (objectFailures > 0) {
      console.warn(
        `[attachments] expired upload cleanup kept ${objectFailures} rows whose objects could not be deleted:`,
        firstFailure instanceof Error ? firstFailure.message : String(firstFailure),
      );
    }
  }
  return { deleted, object_failures: objectFailures };
}

let cleanupTimer: NodeJS.Timeout | null = null;
let cleanupPromise: Promise<void> | null = null;
let cleanupAbort: AbortController | null = null;

export function startAttachmentUploadCleanup(): void {
  if (cleanupTimer) return;
  const abort = new AbortController();
  cleanupAbort = abort;
  const tick = async () => {
    if (cleanupPromise || abort.signal.aborted) return;
    const pending = cleanupExpiredAttachmentUploadsOnce(defaultDeps, sharedState, abort.signal)
      .then(() => undefined, (error: unknown) => {
        console.error("Expired attachment upload cleanup failed:", error);
      })
      .finally(() => {
        if (cleanupPromise === pending) cleanupPromise = null;
      });
    cleanupPromise = pending;
    await pending;
  };
  cleanupTimer = setInterval(() => void tick(), ATTACHMENT_UPLOAD_CLEANUP_INTERVAL_MS);
  cleanupTimer.unref?.();
}

/** Stop the timer and cut short a running sweep: the object delete in flight is aborted. */
export async function stopAttachmentUploadCleanup(): Promise<void> {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  cleanupAbort?.abort();
  cleanupAbort = null;
  await cleanupPromise;
}
