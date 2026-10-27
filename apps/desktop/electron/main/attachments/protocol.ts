import { Buffer } from "node:buffer";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { Readable } from "node:stream";

import { guessMessageAttachmentMimeType } from "../../../../../shared/message-attachments.mjs";
import { readStoredAuth } from "../auth.js";
import { apiUrl } from "../paths.js";
import { realLocalAttachmentPath, resolveLocalAttachmentPath } from "./links.js";

// An image tag never runs script; this keeps it so if a file is opened as a page.
const ATTACHMENT_RESPONSE_SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
  "X-Content-Type-Options": "nosniff",
} as const;

/** The sign-in goes only to a message attachment download, never to another API path. */
const CLOUD_ATTACHMENT_PATH = /^\/(?:rooms|projects)\/[^?#]+\/messages\/[^/]+\/attachments\/[^/]+$/;

export async function handleAttachmentProtocolRequest(request: Request): Promise<Response> {
  return attachmentResponse(request.url);
}

/** The bytes behind a `letagents-attachment://` link, as the screen would load them. */
export async function attachmentResponse(href: string): Promise<Response> {
  try {
    const requestUrl = new URL(href);
    const encodedTarget = requestUrl.pathname.replace(/^\/+/, "");
    if (!encodedTarget) {
      return new Response("Missing attachment target.", { status: 400 });
    }
    const rawTarget = Buffer.from(encodedTarget, "base64url").toString("utf8");
    return requestUrl.hostname === "local"
      ? await localAttachmentResponse(rawTarget)
      : await cloudAttachmentResponse(rawTarget);
  } catch (error) {
    return new Response(
      error instanceof Error ? error.message : "Attachment unavailable.",
      { status: 502 },
    );
  }
}

async function cloudAttachmentResponse(rawTarget: string): Promise<Response> {
  const apiOrigin = new URL(apiUrl).origin;
  const target = rawTarget.startsWith("/") ? new URL(rawTarget, apiOrigin) : new URL(rawTarget);
  if (target.origin !== apiOrigin) {
    throw new Error("Attachment proxy target is outside LetAgents API.");
  }
  if (!CLOUD_ATTACHMENT_PATH.test(target.pathname)) {
    return new Response("Attachment proxy target is not an attachment.", { status: 403 });
  }
  const storedAuth = await readStoredAuth();
  const headers = new Headers();
  if (storedAuth.token) {
    headers.set("Authorization", `Bearer ${storedAuth.token}`);
  }
  const response = await fetch(target, { headers });
  const proxied = new Headers(response.headers);
  // fetch already decoded the body, so its encoding and length no longer apply.
  proxied.delete("Content-Encoding");
  proxied.delete("Content-Length");
  for (const [name, value] of Object.entries(ATTACHMENT_RESPONSE_SECURITY_HEADERS)) proxied.set(name, value);
  const body = [204, 205, 304].includes(response.status) ? null : response.body;
  return new Response(body, { status: response.status, statusText: response.statusText, headers: proxied });
}

async function localAttachmentResponse(relativePath: string): Promise<Response> {
  const filePath = resolveLocalAttachmentPath(relativePath);
  if (!filePath) {
    return new Response("Attachment is outside the local files folder.", { status: 403 });
  }
  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) {
    return new Response("Local attachment file is no longer available.", { status: 404 });
  }
  const realPath = await realLocalAttachmentPath(filePath);
  if (!realPath) {
    return new Response("Attachment is outside the local files folder.", { status: 403 });
  }
  return new Response(Readable.toWeb(createReadStream(realPath)) as ReadableStream, {
    headers: {
      "Content-Type": guessMessageAttachmentMimeType(basename(filePath)),
      "Content-Length": String(info.size),
      ...ATTACHMENT_RESPONSE_SECURITY_HEADERS,
    },
  });
}
