import { ATTACHMENT_PREVIEW_BYTE_LIMIT, isDesktopAttachmentHref } from "../../../../../shared/message-attachments.mjs";
import { attachmentResponse } from "./protocol.js";

class AttachmentPreviewError extends Error {}

export async function readDesktopAttachmentText(href: unknown): Promise<{ text: string } | { error: string }> {
  if (!isDesktopAttachmentHref(href)) return { error: "Preview unavailable for this file." };
  const signal = AbortSignal.timeout(15000);
  try {
    return { text: await decodeAttachmentText(await attachmentResponse(href, signal), signal) };
  } catch (error) {
    return { error: error instanceof AttachmentPreviewError ? error.message : "Couldn’t load this file." };
  }
}

export async function decodeAttachmentText(response: Response, signal?: AbortSignal): Promise<string> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new AttachmentPreviewError("Couldn’t load this file.");
  }
  if (Number(response.headers.get("Content-Length")) > ATTACHMENT_PREVIEW_BYTE_LIMIT) {
    await response.body?.cancel().catch(() => undefined);
    throw new AttachmentPreviewError("This file is too large to preview.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const abortRead = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", abortRead, { once: true });
  let bytes = 0;
  const chunks: string[] = [];
  try {
    signal?.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > ATTACHMENT_PREVIEW_BYTE_LIMIT) throw new AttachmentPreviewError("This file is too large to preview.");
      chunks.push(decode(value));
    }
    chunks.push(decode());
    const text = chunks.join("");
    if (text.includes("\0")) throw new AttachmentPreviewError("This file isn’t UTF-8 text.");
    return text;
  } finally {
    signal?.removeEventListener("abort", abortRead);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  function decode(chunk?: Uint8Array): string {
    try {
      return decoder.decode(chunk, { stream: Boolean(chunk) });
    } catch {
      throw new AttachmentPreviewError("This file isn’t UTF-8 text.");
    }
  }
}
