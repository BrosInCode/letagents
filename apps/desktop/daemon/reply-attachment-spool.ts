import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import {
  MESSAGE_ATTACHMENT_LIMITS,
  formatMessageAttachmentLimit,
  guessMessageAttachmentMimeType,
  type RecordedReplyAttachment,
} from "../../../shared/message-attachments.mjs";
import {
  ATTACHMENT_READ_FLAGS,
  attachmentFileName,
  readWorkspaceAttachmentFile,
  type WorkspaceAttachmentRoots,
} from "../../../shared/workspace-attachment-files.mjs";

export type ReplyAttachmentSnapshotInput = {
  workspacePath: string | null | undefined;
  inboxItemId: string;
  agentId: string;
  providerTurnId: string;
  mcpRequestId: string;
  files: readonly string[];
};

const SNAPSHOT_DEADLINE_MS = 30_000;

/**
 * The daemon-owned copy of the files an agent attached to its final reply.
 *
 * An agent names files in its workspace while its turn runs; the daemon copies
 * them here at once, so later edits are not sent and the bytes survive a daemon
 * restart until the reply is published. The journal keeps only each copy's id,
 * name, type, size and SHA-256, never the agent's path.
 */
export class ReplyAttachmentSpool {
  constructor(private readonly root: string) {}

  async snapshot(input: ReplyAttachmentSnapshotInput): Promise<{ files: RecordedReplyAttachment[] }> {
    // The copy runs inside the journal reservation; a hung mount must not hold it forever.
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Attaching the files took too long. Try smaller files, or files already on this disk.")), SNAPSHOT_DEADLINE_MS);
      timer.unref();
    });
    try {
      return await Promise.race([this.snapshotOnce(input), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async snapshotOnce(input: ReplyAttachmentSnapshotInput): Promise<{ files: RecordedReplyAttachment[] }> {
    if (!input.workspacePath || !isAbsolute(input.workspacePath)) {
      throw new Error("Reply attachments need this agent's workspace folder.");
    }
    if (input.files.length < 1 || input.files.length > MESSAGE_ATTACHMENT_LIMITS.maxFiles) {
      throw new Error(`Attach 1 to ${MESSAGE_ATTACHMENT_LIMITS.maxFiles} files.`);
    }
    const workspace = await realpath(input.workspacePath);
    // The agent names files through its own workspace path, which may pass through a link (macOS /var is /private/var).
    const roots = { workspace, aliases: [resolve(input.workspacePath)] };
    await mkdir(this.itemFolder(input.inboxItemId), { recursive: true, mode: 0o700 });
    const folder = await this.realItemFolder(input.inboxItemId);
    const files: RecordedReplyAttachment[] = [];
    const created: string[] = [];
    let total = 0;
    try {
      for (const [index, requested] of input.files.entries()) {
        // The same request id always names the same copy, so a replayed call journals the same record.
        const spoolId = digest(JSON.stringify([input.agentId, input.providerTurnId, input.mcpRequestId, index])).slice(0, 32);
        const target = join(folder, spoolId);
        let bytes = await readSpoolCopy(target);
        if (!bytes) {
          bytes = await this.copy(roots, requested, target);
          created.push(target);
        }
        const name = attachmentFileName(requested);
        total += bytes.byteLength;
        if (total > MESSAGE_ATTACHMENT_LIMITS.maxTotalBytes) {
          throw new Error(`The attached files are larger than ${formatMessageAttachmentLimit(MESSAGE_ATTACHMENT_LIMITS.maxTotalBytes)} together.`);
        }
        files.push({ spool_id: spoolId, name, mime_type: guessMessageAttachmentMimeType(name), size_bytes: bytes.byteLength, sha256: digest(bytes) });
      }
    } catch (error) {
      // A refused call keeps nothing it copied.
      await Promise.all(created.map((target) => rm(target, { force: true }).catch(() => undefined)));
      throw error;
    }
    return { files };
  }

  /** After a choice is journaled, keep only the copies it names; an earlier choice can no longer be published. */
  async keepOnly(inboxItemId: string, spoolIds: readonly string[]): Promise<void> {
    const folder = this.itemFolder(inboxItemId);
    const keep = new Set(spoolIds);
    const names = await readdir(folder).catch(() => [] as string[]);
    await Promise.all(names.filter((name) => !keep.has(name)).map((name) => rm(join(folder, name), { force: true }).catch(() => undefined)));
  }

  /** The exact bytes that were journaled, or an error when the copy is gone or changed. */
  async read(inboxItemId: string, file: RecordedReplyAttachment): Promise<Buffer> {
    const folder = await this.realItemFolder(inboxItemId).catch(() => null);
    const bytes = folder ? await readSpoolCopy(join(folder, file.spool_id)) : null;
    if (!bytes) throw new Error(`The saved copy of ${file.name} is no longer available.`);
    if (bytes.byteLength !== file.size_bytes || digest(bytes) !== file.sha256) {
      throw new Error(`The saved copy of ${file.name} changed after it was attached.`);
    }
    return bytes;
  }

  async remove(inboxItemId: string): Promise<void> {
    await rm(this.itemFolder(inboxItemId), { recursive: true, force: true });
  }

  /** Remove copies no reply needs any more, such as those of a turn that ended with no reply. */
  async sweep(olderThanMs: number, nowMs = Date.now()): Promise<void> {
    const names = await readdir(this.root).catch(() => [] as string[]);
    await Promise.all(names.map(async (name) => {
      const folder = join(this.root, name);
      const info = await stat(folder).catch(() => null);
      if (info?.isDirectory() && nowMs - info.mtimeMs > olderThanMs) await rm(folder, { recursive: true, force: true });
    }));
  }

  private itemFolder(inboxItemId: string): string {
    return join(this.root, digest(inboxItemId).slice(0, 32));
  }

  /** Copies are opened with no symlink allowed anywhere, so open them by the folder's real path. */
  private async realItemFolder(inboxItemId: string): Promise<string> {
    return realpath(this.itemFolder(inboxItemId));
  }

  private async copy(roots: WorkspaceAttachmentRoots, requested: string, target: string): Promise<Buffer> {
    const { bytes } = await readWorkspaceAttachmentFile(roots, requested);
    const temporary = `${target}.${randomUUID()}.partial`;
    await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
    await rename(temporary, target);
    return bytes;
  }
}

/** A spool copy is trusted only as a regular, singly linked file the daemon wrote. */
async function readSpoolCopy(path: string): Promise<Buffer | null> {
  // Windows has no O_NOFOLLOW, so open() would follow a link planted in place of the copy. Refuse a link first.
  if (process.platform === "win32") {
    const found = await lstat(path).catch(() => null);
    if (!found || found.isSymbolicLink()) return null;
  }
  const handle = await open(path, ATTACHMENT_READ_FLAGS).catch(() => null);
  if (!handle) return null;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > MESSAGE_ATTACHMENT_LIMITS.maxFileBytes) return null;
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
