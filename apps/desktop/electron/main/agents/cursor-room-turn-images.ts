import { lstatSync } from "node:fs";
import { dirname } from "node:path";

import { cursorSandboxPathVariants } from "./cursor-sandbox-policy.js";
import { includedRoomTurnImages } from "./desktop-event-prompt-format.js";
import type { ProviderRoomTurnRequest } from "./provider-adapter.js";

/**
 * cursor-agent has no image input: its agent opens an image file with its
 * own read tool. The daemon staged each image in a folder that this turn's
 * sandbox may read and nothing may write or run.
 */
export function cursorRoomTurnImageLines(request: ProviderRoomTurnRequest): string[] {
  const images = includedRoomTurnImages(request.attachments).filter(image => image.path && stagedImageFolderIsPlain(dirname(image.path)));
  if (!images.length) return [];
  return [
    "The attached images are files on this machine. Open each one with your file-reading tool to see it before you answer:",
    ...images.map(image => `- Image ${image.number} (${JSON.stringify(image.fileName)}): ${image.path}`),
  ];
}

/** The folders of this turn's staged images: read-only for this one launch. */
export function cursorRoomTurnImageFolders(request: ProviderRoomTurnRequest): string[] {
  return [...new Set(includedRoomTurnImages(request.attachments).flatMap(image => image.path ? [dirname(image.path)] : []))]
    .filter(stagedImageFolderIsPlain);
}

/** A staged folder that was replaced by a link, or is not this user's own folder, is never opened to the sandbox. */
function stagedImageFolderIsPlain(folder: string): boolean {
  try {
    const stat = lstatSync(folder);
    return stat.isDirectory() && !stat.isSymbolicLink() && (typeof process.getuid !== "function" || stat.uid === process.getuid());
  } catch { return false; }
}

/** A sandbox path list with this launch's image folders added, so nothing may write to them. */
export function withReadOnlyImageFolders(paths: string[] | undefined, folders: readonly string[]): string[] | undefined {
  return folders.length ? [...new Set([...(paths ?? []), ...folders.flatMap(cursorSandboxPathVariants)])] : paths;
}
