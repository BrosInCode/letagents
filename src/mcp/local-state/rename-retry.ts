// The bounded Windows rename retry lives in shared/ so the desktop daemon and
// the agent code use the same rule; see shared/rename-retry.mjs.
export {
  RENAME_RETRY_CODES,
  RENAME_RETRY_DELAYS_MS,
  isRetryableRenameError,
  renameWithRetry,
  sleepSync,
  type RenameFn,
} from "../../../shared/rename-retry.mjs";
