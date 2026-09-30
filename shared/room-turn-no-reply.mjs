/**
 * Why a completed provider turn ended without a room reply. The Open Model
 * adapter reports these as the exact failure detail, and task continuity
 * reads them back to decide whether a follow-up turn can help.
 */
export const NO_REPLY_FAILURE = Object.freeze({
  outputLimit: "The model hit its output limit before writing a reply.",
  emptyAnswer: "The model finished without writing a reply.",
  contentFilter: "The model provider's content filter stopped the reply before any text was written.",
});

export function noReplyFailureKind(detail) {
  const text = typeof detail === "string" ? detail.trim() : "";
  return Object.keys(NO_REPLY_FAILURE).find((kind) => NO_REPLY_FAILURE[kind] === text) ?? null;
}
