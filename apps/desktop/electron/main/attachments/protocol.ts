import { Buffer } from "node:buffer";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { Readable } from "node:stream";

import { guessMessageAttachmentMimeType } from "../../../../../shared/message-attachments.mjs";
import { readStoredAuth } from "../auth.js";
import { apiUrl } from "../paths.js";
import { realLocalAttachmentPath, resolveLocalAttachmentPath } from "./links.js";

export async function handleAttachmentProtocolRequest(request: Request): Promise<Response> {
  try {
    const requestUrl = new URL(request.url);
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
  const storedAuth = await readStoredAuth();
  const headers = new Headers();
  if (storedAuth.token) {
    headers.set("Authorization", `Bearer ${storedAuth.token}`);
  }
  return fetch(target, { headers });
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
      // An image tag never runs script; this keeps it so if a file is opened as a page.
      "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
