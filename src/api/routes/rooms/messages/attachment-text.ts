import type { Response } from "express";

import { readBoundedBody } from "../../../../../shared/attachment-download.mjs";
import { getMessageAttachment } from "../../../db.js";
import { createPresignedAttachmentDownload, isAttachmentStorageConfigured } from "../../../messages/attachment-storage.js";
import { PDF_TEXT_LIMITS, PdfTextError, pdfTextFor, type PdfTextFailure } from "../../../pdf-text/extract.js";

/** Characters of text in one answer; `page` reads on. The MCP tool pages text files the same way. */
export const ATTACHMENT_TEXT_PAGE_CHARS = 50_000;
/** Storage gets this long to send a PDF. */
const STORAGE_TIMEOUT_MS = 30_000;

const FAILURES: Record<PdfTextFailure, { status: number; code: string; message: string }> = {
  encrypted: { status: 422, code: "PDF_ENCRYPTED", message: "The PDF is protected with a password, so its text cannot be read." },
  invalid: { status: 422, code: "PDF_INVALID", message: "The file is not a PDF that can be read." },
  too_complex: { status: 422, code: "PDF_TOO_COMPLEX", message: "The PDF is too large or too complex to read here." },
  busy: { status: 503, code: "PDF_BUSY", message: "Too many PDFs are being read now. Try again in a moment." },
  unavailable: { status: 503, code: "PDF_TEXT_UNAVAILABLE", message: "This LetAgents server cannot read PDFs." },
};

function isPdfAttachment(attachment: { content_type: string; filename: string }): boolean {
  return attachment.content_type.toLowerCase().split(";")[0]!.trim() === "application/pdf" || /\.pdf$/i.test(attachment.filename);
}

/**
 * The text of a PDF attached to a message in a resolved room, a window of
 * pages at a time: from `page` (default 1) on, whole pages until about
 * ATTACHMENT_TEXT_PAGE_CHARS characters. A page longer than that is cut, and
 * the answer says so. The PDF is read on the server, once, and kept a while.
 */
export async function respondWithAttachmentText(
  res: Response,
  roomId: string,
  messageId: string,
  attachmentId: string,
  rawPage: unknown,
): Promise<void> {
  const page = rawPage === undefined ? 1 : typeof rawPage === "string" && /^[1-9]\d{0,6}$/.test(rawPage) ? Number(rawPage) : null;
  if (page === null) {
    res.status(400).json({ error: "page must be a whole number from 1.", code: "INVALID_PAGE" });
    return;
  }
  const attachment = await getMessageAttachment(roomId, messageId, attachmentId);
  if (!attachment) {
    res.status(404).json({ error: "Attachment not found", code: "ATTACHMENT_NOT_FOUND" });
    return;
  }
  if (!isPdfAttachment(attachment)) {
    res.status(415).json({ error: "Only PDF attachments have a text view.", code: "NOT_PDF" });
    return;
  }
  if (!isAttachmentStorageConfigured()) {
    res.status(503).json({ error: "Attachment object storage is not configured" });
    return;
  }
  if (attachment.byte_size > PDF_TEXT_LIMITS.maxBytes) {
    res.status(413).json({ error: "The PDF is larger than the server reads.", code: "PDF_TOO_LARGE" });
    return;
  }

  let text;
  try {
    text = await pdfTextFor(`${attachment.bucket}/${attachment.object_key}`, async () => {
      // The storage address the server signs itself; no redirect is followed.
      const stored = await fetch(createPresignedAttachmentDownload(attachment), {
        redirect: "error",
        signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
      });
      if (!stored.ok) {
        await stored.body?.cancel().catch(() => undefined);
        throw new Error(`storage answered ${stored.status}`);
      }
      const bytes = await readBoundedBody(stored, PDF_TEXT_LIMITS.maxBytes);
      // A file named .pdf that is something else is not handed to the reader.
      if (new TextDecoder("latin1").decode(bytes.subarray(0, 1024)).indexOf("%PDF-") === -1) throw new PdfTextError("invalid");
      return bytes;
    });
  } catch (error) {
    if (error instanceof PdfTextError) {
      const failure = FAILURES[error.reason];
      if (error.reason === "busy") res.setHeader("Retry-After", "5");
      res.status(failure.status).json({ error: failure.message, code: failure.code });
      return;
    }
    res.status(502).json({ error: "The PDF could not be fetched from storage. Try again shortly.", code: "PDF_FETCH_FAILED" });
    return;
  }

  if (page > text.pages.length) {
    res.status(400).json({
      error: text.pages.length < text.pageCount
        ? `The server reads the first ${text.pages.length} pages of this PDF; page ${page} is past them.`
        : `The PDF has ${text.pageCount} page${text.pageCount === 1 ? "" : "s"}; there is no page ${page}.`,
      code: "PAGE_OUT_OF_RANGE",
    });
    return;
  }
  const pages: Array<{ page: number; text: string; cut?: true }> = [];
  let chars = 0;
  for (let number = page; number <= text.pages.length; number += 1) {
    const pageText = text.pages[number - 1]!;
    if (pages.length > 0 && chars + pageText.length > ATTACHMENT_TEXT_PAGE_CHARS) break;
    if (pageText.length > ATTACHMENT_TEXT_PAGE_CHARS) {
      let end = ATTACHMENT_TEXT_PAGE_CHARS;
      // Never end between the two halves of one character (an emoji, for example).
      if (/[\uD800-\uDBFF]/.test(pageText[end - 1]!)) end -= 1;
      pages.push({ page: number, text: pageText.slice(0, end), cut: true });
      chars += end;
      break;
    }
    pages.push({ page: number, text: pageText });
    chars += pageText.length;
  }
  const lastPage = pages.at(-1)?.page ?? null;
  res.status(200).json({
    ok: true,
    kind: "pdf",
    page_count: text.pageCount,
    // Pages past the server's limits were not read.
    read_pages: text.pages.length,
    truncated: text.truncated,
    first_page: pages[0]?.page ?? null,
    last_page: lastPage,
    ...(lastPage !== null && lastPage < text.pages.length ? { next_page: lastPage + 1 } : {}),
    has_text: text.pages.some((pageText) => pageText.trim().length > 0),
    pages,
  });
}
