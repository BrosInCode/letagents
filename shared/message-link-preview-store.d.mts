import type { LinkPreviewReference, MessageLinkPreview, MessageLinkPreviewsResponse } from "./message-link-previews.mjs";
export function createMessageLinkPreviewStore(options: {
  load(references: LinkPreviewReference[]): Promise<MessageLinkPreviewsResponse>;
  onChange?(): void; refreshDelayMs?: number;
}): {
  track(message: { id: string; references: LinkPreviewReference[] }): () => void;
  get(messageId: string): MessageLinkPreview[];
  refresh(): Promise<void>;
  reset(): void;
};
