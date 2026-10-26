import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";

import {
  MESSAGE_ATTACHMENT_LIMITS,
  discardCloudMessageAttachment,
  formatMessageAttachmentLimit,
  stageCloudMessageAttachment,
  type MessageAttachmentTransport,
  type StagedCloudMessageAttachment,
} from "../../../../shared/message-attachments.mjs";
import { isLocalRoomApi } from "../../../../shared/room-api-origin.mjs";
import {
  isFileSystemRoot,
  readWorkspaceAttachmentFile,
  workspaceAliases,
  type WorkspaceAttachmentFile,
  type WorkspaceAttachmentRoots,
} from "../../../../shared/workspace-attachment-files.mjs";
import { encodeRoomIdPath } from "../../room-id.js";
import { ApiError, getApiUrl, parseApiErrorPayload } from "./api.js";
import { getDaemonToolExecutionContext, getRuntimeWorkingDirectory } from "./daemon-tool-context.js";
import { roomScopedApiCall } from "./room-api.js";
import { currentSessionScope } from "./session-scope.js";

/**
 * Files an agent attaches to send_message or send_thread_message through the
 * npm MCP server. The server reads them with the owner's rights, so it reads
 * only inside the agent's workspace, with the checks the desktop daemon uses
 * for set_reply_attachments. It stages them with the credential it posts
 * with, because the room lets only the uploader attach an upload.
 */

const UPLOAD_TIMEOUT_MS = 120_000;
// A hung network mount or cloud placeholder file must not hold the tool call forever.
const READ_DEADLINE_MS = 30_000;
const NOTHING_POSTED = "Nothing was posted.";

/** Refuse where this process cannot read the agent's files, or the room cannot take them. */
export function assertMessageFileAttachmentsAvailable(): void {
  if (currentSessionScope()) {
    throw new Error("The remote LetAgents MCP endpoint cannot read files on your computer. Attach files through the npm package (npx letagents).");
  }
  const profile = process.env.LETAGENTS_EXECUTION_PROFILE?.trim();
  if (getDaemonToolExecutionContext() || profile === "supervised_room_turn" || profile === "supervised_mcp_polling") {
    throw new Error("Desktop room agents attach files to their reply with set_reply_attachments.");
  }
  if (isLocalRoomApi(getApiUrl())) throw localRoomAttachmentError();
}

export function localRoomAttachmentError(): Error {
  return new Error(`Local rooms cannot take attachments. Send the message without attachments. ${NOTHING_POSTED}`);
}

function contains(folder: string, path: string): boolean {
  const inside = relative(folder, path);
  return inside === "" || (inside !== ".." && !inside.startsWith("../") && !inside.startsWith("..\\") && !isAbsolute(inside));
}

/**
 * The checkout around a folder, found by its `.git` entry. Git itself is not
 * asked: `core.worktree` or an inherited GIT_DIR could name any folder.
 */
async function checkoutAround(folder: string): Promise<string | null> {
  for (let current = folder; ; current = dirname(current)) {
    if (await lstat(join(current, ".git")).then(() => true, () => false)) return current;
    if (isFileSystemRoot(current)) return null;
  }
}

/**
 * The folder files may come from: the checkout around the MCP server's working
 * folder, or that folder outside a checkout. Relative names resolve against
 * the working folder. A home folder, or a folder around it, is not a project:
 * attaching from it would reach every file the owner has.
 */
export async function resolveAttachmentWorkspace(): Promise<Required<WorkspaceAttachmentRoots>> {
  const logicalWorkingDirectory = getRuntimeWorkingDirectory();
  const workingDirectory = await realpath(logicalWorkingDirectory);
  const home = await realpath(homedir()).catch(() => null);
  const project = (folder: string) => !isFileSystemRoot(folder) && !(home && contains(folder, home));
  const checkout = await checkoutAround(workingDirectory);
  // A home folder kept in git (dotfiles) is not a project; a folder below it may be.
  const workspace = checkout && project(checkout) ? checkout : workingDirectory;
  if (!project(workspace)) {
    throw new Error(`Attachments need a project folder, but this MCP server runs in ${workspace}. Start it in your project folder (set "cwd" in its MCP configuration). ${NOTHING_POSTED}`);
  }
  // The agent may name files through the shell's path, or a Windows short name, of the same folder.
  const aliases = await workspaceAliases(workspace, workingDirectory, [logicalWorkingDirectory, process.env.PWD]);
  return { workspace, aliases, baseDirectory: workingDirectory };
}

async function withinReadDeadline<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Reading the files took too long. Attach smaller files, or files already on this disk. ${NOTHING_POSTED}`)), READ_DEADLINE_MS);
    timer.unref();
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Read every file, one at a time, before any upload, so a refused file stages nothing. */
export async function readMessageAttachmentFiles(files: readonly string[]): Promise<WorkspaceAttachmentFile[]> {
  if (files.length < 1 || files.length > MESSAGE_ATTACHMENT_LIMITS.maxFiles) {
    throw new Error(`Attach 1 to ${MESSAGE_ATTACHMENT_LIMITS.maxFiles} files. ${NOTHING_POSTED}`);
  }
  const roots = await resolveAttachmentWorkspace();
  return withinReadDeadline((async () => {
    const read: WorkspaceAttachmentFile[] = [];
    let total = 0;
    for (const requested of files) {
      const file = await readWorkspaceAttachmentFile(roots, requested).catch((error: Error) => {
        throw new Error(`${error.message} ${NOTHING_POSTED} The workspace is ${roots.workspace}.`);
      });
      total += file.bytes.byteLength;
      if (total > MESSAGE_ATTACHMENT_LIMITS.maxTotalBytes) {
        throw new Error(`The attached files are larger than ${formatMessageAttachmentLimit(MESSAGE_ATTACHMENT_LIMITS.maxTotalBytes)} together. ${NOTHING_POSTED}`);
      }
      read.push(file);
    }
    return read;
  })());
}

/**
 * The staging contract builds `${roomPath}/attachments/uploads`; this transport
 * puts the room's own path in front, through the same room resolution, origin
 * header and credential as the message it will be attached to.
 */
function roomTransport(roomId: string): MessageAttachmentTransport {
  return {
    requestJson: (path, init) => roomScopedApiCall({
      room_id: roomId,
      project_id: null,
      room_path: (apiRoomId) => `/rooms/${encodeRoomIdPath(apiRoomId)}${path}`,
      project_path: () => path,
      options: init,
    }),
    fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) }),
  };
}

function stagingErrorText(fileName: string, error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return `Attachments need a signed-in LetAgents account. Run start_device_auth, then send again. ${NOTHING_POSTED}`;
    if (error.status === 403) return `This room does not let this agent upload files. ${NOTHING_POSTED}`;
    if (error.status === 503) return `This LetAgents server has no file storage, so it cannot take attachments. ${NOTHING_POSTED}`;
    const reason = parseApiErrorPayload(error)?.error;
    return `${fileName} could not be uploaded (HTTP ${error.status}${typeof reason === "string" ? `: ${reason.slice(0, 200)}` : ""}). ${NOTHING_POSTED}`;
  }
  const detail = error instanceof Error && error.name === "TimeoutError" ? "the upload took too long" : error instanceof Error ? error.message : String(error);
  return `${fileName} could not be uploaded: ${detail} ${NOTHING_POSTED}`;
}

/** Stage the files in order. On any failure, discard what was staged and post nothing. */
export async function stageMessageAttachments(
  roomId: string,
  files: readonly WorkspaceAttachmentFile[],
): Promise<StagedCloudMessageAttachment[]> {
  const transport = roomTransport(roomId);
  const staged: StagedCloudMessageAttachment[] = [];
  for (const file of files) {
    try {
      staged.push(await stageCloudMessageAttachment(transport, {
        roomPath: "",
        fileName: file.name,
        mimeType: file.mimeType,
        bytes: file.bytes,
      }));
    } catch (error) {
      await discardMessageAttachments(roomId, staged);
      throw new Error(stagingErrorText(file.name, error));
    }
  }
  return staged;
}

/** Best effort: an upload the room never attaches expires on its own. */
export async function discardMessageAttachments(roomId: string, staged: readonly StagedCloudMessageAttachment[]): Promise<void> {
  const transport = roomTransport(roomId);
  await Promise.all(staged.map((file) => discardCloudMessageAttachment(transport, { roomPath: "", uploadId: file.uploadId })
    .catch(() => undefined)));
}
