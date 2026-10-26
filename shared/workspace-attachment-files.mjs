import { constants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import { workspacePathMayHoldCredentials } from "./credential-paths.mjs";
import {
  MESSAGE_ATTACHMENT_LIMITS,
  formatMessageAttachmentLimit,
  guessMessageAttachmentMimeType,
} from "./message-attachments.mjs";

/**
 * Reads the workspace files an agent attaches to a room message. The desktop
 * daemon and the npm MCP server both read them with the owner's rights,
 * outside the agent's sandbox, so both use this one reader and these checks:
 *   1. The name, as text, must be inside the workspace. Nothing outside it is
 *      looked up, so a Windows network path never connects to its host.
 *   2. Every part below the workspace is looked at without following it; a
 *      symlink or Windows junction anywhere is refused.
 *   3. The file must be regular, singly linked, not empty and within the size
 *      limit, and must not be a file that may hold credentials.
 *   4. The open file must be the file that was checked. macOS refuses a
 *      symlink anywhere in the path in the open itself (O_NOFOLLOW_ANY; macOS
 *      rejects it combined with O_NOFOLLOW). Linux refuses one as the last
 *      part, and the kernel then names the opened file exactly. Windows has
 *      neither, so there the path is checked again after the read: a folder
 *      swapped for a junction in that moment is the one race left, and agents
 *      on Windows are not sandboxed from the owner's files to begin with.
 * O_NONBLOCK keeps a named pipe from blocking the open.
 */
const O_NOFOLLOW_ANY = 0x20000000;
const DARWIN = process.platform === "darwin";
const LINUX = process.platform === "linux";
const WINDOWS = process.platform === "win32";
const NO_SYMLINKS = DARWIN ? O_NOFOLLOW_ANY : (constants.O_NOFOLLOW ?? 0);
export const ATTACHMENT_READ_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | NO_SYMLINKS;

/** Names Windows opens as a device, in any folder and with any extension. */
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/** The name a room shows for an attached file: its base name, without control characters. */
export function attachmentFileName(requested) {
  const name = basename(String(requested).replace(/\\/g, "/")).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 160).trim();
  return name || "attachment";
}

function isInside(folder, path) {
  const inside = relative(folder, path);
  return Boolean(inside) && inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside);
}

function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}

function outsideError(requested) {
  return new Error(`${requested} is outside your workspace, or is reached through a link. Attach only files inside it, by their own path.`);
}

function changedError(requested) {
  return new Error(`${requested} changed while it was being attached. Try again.`);
}

function samePath(a, b) {
  return WINDOWS ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Read one file an agent named. `workspace` is the workspace's real path,
 * with no link in it; `aliases` are other names of that same folder (the
 * agent may name files through them); a relative name resolves against
 * `baseDirectory`, which defaults to the workspace.
 */
export async function readWorkspaceAttachmentFile({ workspace, aliases = [], baseDirectory = workspace }, requested) {
  const candidate = resolve(baseDirectory, requested);
  const root = [workspace, ...aliases].find((folder) => isInside(folder, candidate));
  if (!root) throw outsideError(requested);
  const parts = relative(root, candidate).split(sep);
  if (WINDOWS) {
    // A colon names an alternate data stream (`auth.json::$DATA` reads auth.json),
    // and Windows drops a trailing dot or space when it opens a name.
    if (parts.some((part) => part.includes(":") || WINDOWS_DEVICE_NAME.test(part) || /[. ]$/.test(part))) {
      throw new Error(`${requested} is not a plain file name. Attach the file by its own name.`);
    }
  }
  if (workspacePathMayHoldCredentials(parts)) throw new Error(`${requested} may hold credentials, so it is never attached.`);

  // Walk down from the real workspace without following anything.
  let path = workspace;
  let before;
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    before = await lstat(path, { bigint: true }).catch((error) => {
      throw new Error(error?.code === "ENOENT" || error?.code === "ENOTDIR"
        ? `${requested} does not exist in your workspace.`
        : `${requested} could not be read.`);
    });
    if (before.isSymbolicLink()) throw outsideError(requested);
    if (index < parts.length - 1 && !before.isDirectory()) throw new Error(`${requested} does not exist in your workspace.`);
  }
  if (!before.isFile()) throw new Error(`${requested} is not a regular file.`);
  // The walk found no link, so this only spells the path out in full: Windows
  // expands a short name such as SECRET~1.JSO, and the credential check runs
  // again on what the file system will open.
  const real = await realpath(path).catch(() => {
    throw changedError(requested);
  });
  if (!isInside(workspace, real)) throw changedError(requested);
  if (workspacePathMayHoldCredentials(relative(workspace, real).split(sep))) {
    throw new Error(`${requested} may hold credentials, so it is never attached.`);
  }

  const handle = await open(path, ATTACHMENT_READ_FLAGS).catch((error) => {
    throw error?.code === "ELOOP" ? changedError(requested) : new Error(`${requested} could not be read.`);
  });
  let bytes;
  try {
    bytes = await readRegularFile(handle, requested, before);
    if (LINUX) {
      // The kernel names the file this handle opened, whatever happened to the path.
      const opened = await readlink(`/proc/self/fd/${handle.fd}`).catch(() => null);
      if (opened !== real) throw changedError(requested);
    }
  } finally {
    await handle.close();
  }
  if (!DARWIN && !LINUX && !(await stillTheOpenedFile(path, real, before))) throw changedError(requested);
  const name = attachmentFileName(requested);
  return { name, mimeType: guessMessageAttachmentMimeType(name), bytes };
}

/** Best effort where the open can follow a junction in a parent folder: after the read, the path still names the opened file. */
async function stillTheOpenedFile(path, real, opened) {
  const again = await realpath(path).catch(() => null);
  if (!again || !samePath(again, real)) return false;
  const after = await lstat(path, { bigint: true }).catch(() => null);
  return Boolean(after?.isFile()) && sameFile(after, opened);
}

/**
 * Read exactly the size the open file had: a file that grows during the read is
 * refused instead of read without bound, and a named pipe never blocks.
 */
async function readRegularFile(handle, requested, before) {
  const info = await handle.stat({ bigint: true });
  if (!info.isFile()) throw new Error(`${requested} is not a regular file.`);
  if (!sameFile(info, before)) throw changedError(requested);
  // A hard link can name a file from outside the workspace under an inside path.
  if (info.nlink > 1n) throw new Error(`${requested} is a hard link, so it is not attached.`);
  if (info.size === 0n) throw new Error(`${requested} is empty.`);
  if (info.size > BigInt(MESSAGE_ATTACHMENT_LIMITS.maxFileBytes)) {
    throw new Error(`${requested} is larger than ${formatMessageAttachmentLimit(MESSAGE_ATTACHMENT_LIMITS.maxFileBytes)}.`);
  }
  const size = Number(info.size);
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(bytes, offset, size - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  const { bytesRead: beyond } = await handle.read(Buffer.alloc(1), 0, 1, size);
  if (offset !== size || beyond !== 0) throw changedError(requested);
  return bytes;
}

/**
 * Other names of the folder `real` that a caller may use: each logical name
 * of the working folder (such as the shell's PWD, or a Windows short name)
 * that still resolves to it, carried up to the workspace root above it.
 */
export async function workspaceAliases(workspace, workingDirectory, logicalWorkingDirectories) {
  const up = relative(workingDirectory, workspace);
  const aliases = [];
  for (const logical of logicalWorkingDirectories) {
    if (!logical || !isAbsolute(logical)) continue;
    const resolvedLogical = await realpath(logical).catch(() => null);
    if (!resolvedLogical || !samePath(resolvedLogical, workingDirectory)) continue;
    const alias = resolve(logical, up);
    if (samePath(alias, workspace) || aliases.some((known) => samePath(known, alias))) continue;
    const resolvedAlias = await realpath(alias).catch(() => null);
    if (resolvedAlias && samePath(resolvedAlias, workspace)) aliases.push(alias);
  }
  return aliases;
}

/** The root of a path, so a caller can refuse a workspace that is a whole drive or file system. */
export function isFileSystemRoot(path) {
  return parse(path).root === path;
}
