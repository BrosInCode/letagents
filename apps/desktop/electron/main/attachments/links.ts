import { Buffer } from "node:buffer";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { localFilesPath } from "../chat-storage/settings.js";
import { apiUrl, attachmentProtocolScheme } from "../paths.js";

/**
 * The screen loads every attachment through one scheme:
 *   letagents-attachment://download/<api path>  a cloud file, fetched with the stored sign-in
 *   letagents-attachment://local/<file path>    a local-room file inside the local files folder
 * Both targets are base64url encoded so the screen never builds them itself.
 */
export function cloudAttachmentHref(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("/")) {
    let target: URL;
    try {
      target = new URL(trimmed);
    } catch {
      return null;
    }
    if (target.origin !== new URL(apiUrl).origin) {
      return target.protocol === "https:" || target.protocol === "http:" ? trimmed : null;
    }
  }
  return `${attachmentProtocolScheme}://download/${Buffer.from(trimmed, "utf8").toString("base64url")}`;
}

export function localAttachmentHref(fileUrl: string): string | null {
  const relativePath = localAttachmentRelativePath(fileUrl);
  return relativePath === null
    ? null
    : `${attachmentProtocolScheme}://local/${Buffer.from(relativePath, "utf8").toString("base64url")}`;
}

/** The path of a local attachment file relative to the local files folder, or null when it is outside it. */
export function localAttachmentRelativePath(fileUrl: string): string | null {
  if (!fileUrl.startsWith("file:")) return null;
  let filePath: string;
  try {
    filePath = fileURLToPath(fileUrl);
  } catch {
    return null;
  }
  return relativeInsideLocalFiles(filePath);
}

/** Resolve a relative path from the attachment protocol back to a file inside the local files folder. */
export function resolveLocalAttachmentPath(relativePath: string): string | null {
  const filePath = resolve(localFilesPath, relativePath);
  return relativeInsideLocalFiles(filePath) === null ? null : filePath;
}

/**
 * The real file a local attachment names, after symlinks, or null when that
 * file is not inside the real local files folder. Reading always uses this.
 */
export async function realLocalAttachmentPath(filePath: string): Promise<string | null> {
  const [folder, file] = await Promise.all([
    realpath(localFilesPath).catch(() => null),
    realpath(filePath).catch(() => null),
  ]);
  if (!folder || !file) return null;
  return insideFolder(folder, file) === null ? null : file;
}

function relativeInsideLocalFiles(filePath: string): string | null {
  return insideFolder(resolve(localFilesPath), resolve(filePath));
}

/** The path of `filePath` relative to `folder`, or null when it is not strictly inside it. */
export function insideFolder(folder: string, filePath: string): string | null {
  const relativePath = relative(folder, filePath);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) return null;
  return relativePath;
}
