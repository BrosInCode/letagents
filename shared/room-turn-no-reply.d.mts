export const NO_REPLY_FAILURE: Readonly<{
  outputLimit: "The model hit its output limit before writing a reply.";
  emptyAnswer: "The model finished without writing a reply.";
  contentFilter: "The model provider's content filter stopped the reply before any text was written.";
}>;
export type NoReplyFailureKind = keyof typeof NO_REPLY_FAILURE;
export function noReplyFailureKind(detail: unknown): NoReplyFailureKind | null;
