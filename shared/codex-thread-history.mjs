// Attachment and recovery require readable native turn history. Codex 0.153.4
// can default to paginated threads whose history API is unavailable. Select
// the verified contract only for creation; never reinterpret an existing thread.
export const CODEX_THREAD_HISTORY_MODE = "legacy";
