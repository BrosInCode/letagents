import { attachmentProtocolScheme, htmlDemoProtocolScheme } from "../paths.js";

/**
 * An HTML demo is a single file someone attached to a room message. It opens
 * in its own window with no preload, no Node and no app sign-in, and nothing
 * loads over the network: scripts and styles must be inline, and images must
 * be data: or blob: URLs. Known limits: the page can still cause DNS lookups
 * (DNS prefetch, WebRTC), and it can read a file the person drops or picks in it.
 */
export const MAX_HTML_DEMO_BYTES = 10 * 1024 * 1024;
export const MAX_OPEN_HTML_DEMOS = 6;
/** In-memory partition (no `persist:`), so demo storage never reaches disk. */
export const HTML_DEMO_PARTITION = "letagents-html-demos";

export const HTML_DEMO_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' blob:",
  "style-src 'unsafe-inline' data: blob:",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "connect-src data: blob:",
  "worker-src blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "manifest-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  // Scripts and its own storage only: no dialogs, printing, forms, pop-ups, downloads or top navigation.
  "sandbox allow-scripts allow-same-origin",
].join("; ");

export const HTML_DEMO_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": HTML_DEMO_CONTENT_SECURITY_POLICY,
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), display-capture=(), usb=(), serial=(), hid=(), bluetooth=(), payment=()",
};

/** The demo's own document and in-page data are the only requests a demo window makes. */
export function isAllowedHtmlDemoRequest(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  return url.protocol === `${htmlDemoProtocolScheme}:`
    || url.protocol === "data:"
    || url.protocol === "blob:";
}

/** Only attachment links the app itself made may open as a demo. */
export function assertHtmlDemoAttachmentHref(rawHref: unknown): string {
  if (typeof rawHref !== "string") {
    throw new Error("The demo link is missing.");
  }
  let url: URL;
  try {
    url = new URL(rawHref);
  } catch {
    throw new Error("The demo link is invalid.");
  }
  if (url.protocol !== `${attachmentProtocolScheme}:` || (url.hostname !== "download" && url.hostname !== "local")) {
    throw new Error("Only room attachments open as demos.");
  }
  return url.toString();
}

export function htmlDemoWindowTitle(fileName: unknown, senderLabel: unknown): string {
  const name = cleanLabel(fileName) || "demo.html";
  const sender = cleanLabel(senderLabel);
  return sender ? `Demo · ${name} · from ${sender}` : `Demo · ${name}`;
}

function cleanLabel(value: unknown): string {
  return typeof value === "string"
    // Control characters, and direction marks that could reorder "from <sender>".
    ? value.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").trim().slice(0, 120)
    : "";
}

/** Read a response body, stopping as soon as it passes `limit` bytes. */
export async function readHtmlDemoBytes(response: Response, limit = MAX_HTML_DEMO_BYTES): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(htmlDemoTooLargeMessage(limit));
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error(htmlDemoTooLargeMessage(limit));
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function htmlDemoTooLargeMessage(limit: number): string {
  return `This demo is larger than ${Math.round(limit / (1024 * 1024))} MB, so it does not open in the viewer.`;
}
