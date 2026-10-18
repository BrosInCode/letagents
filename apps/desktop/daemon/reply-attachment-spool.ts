import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, realpath, rename, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  MESSAGE_ATTACHMENT_LIMITS,
  formatMessageAttachmentLimit,
  guessMessageAttachmentMimeType,
  type RecordedReplyAttachment,
} from "../../../shared/message-attachments.mjs";
import { executionApprovalProjectionPathsAreSafe } from "./execution-approval-projection-policy.js";

export type ReplyAttachmentSnapshotInput = {
  workspacePath: string | null | undefined;
  inboxItemId: string;
  agentId: string;
  providerTurnId: string;
  mcpRequestId: string;
  files: readonly string[];
};

/**
 * On macOS, where the daemon runs, O_NOFOLLOW_ANY refuses the open if any part
 * of the path, the last one included, is a symlink, in one kernel call, so a
 * folder swapped for a symlink during the checks cannot redirect it. macOS
 * rejects it combined with O_NOFOLLOW, and other systems ignore the value, so
 * elsewhere (CI) O_NOFOLLOW refuses at least a symlink as the last part.
 * O_NONBLOCK keeps a named pipe from blocking the open.
 */
const O_NOFOLLOW_ANY = 0x20000000;
const NO_SYMLINKS = process.platform === "darwin" ? O_NOFOLLOW_ANY : constants.O_NOFOLLOW;
const READ_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | NO_SYMLINKS;
const SNAPSHOT_DEADLINE_MS = 30_000;

/**
 * Folders and names that hold credentials or an agent tool's private
 * configuration. The daemon reads with the owner's rights, outside the agent's
 * sandbox, so it never attaches them. Workspace containment is the main control;
 * this list and the approval-projection list are defence in depth.
 */
const SECRET_FOLDERS = new Set([
  ".git", ".ssh", ".aws", ".azure", ".gnupg", ".kube", ".docker", ".terraform",
  ".codex", ".claude", ".cursor", ".letagents", ".vscode", ".idea", "secrets", "credentials",
]);
const SECRET_NAMES = [
  /^\.env/, /^\.dev\.vars/, /^\.letagents/, /^\.mcp\.json$/,
  /^\.(npmrc|netrc|pypirc|pgpass|git-credentials|htpasswd|vault-token|yarnrc\.yml)$/,
  /^id_(rsa|dsa|ecdsa|ed25519)/, /^authorized_keys$/, /^known_hosts$/, /^kubeconfig/,
  /\.(pem|key|p8|p12|pfx|ppk|jks|keystore|kdbx|tfvars|tfstate)(\.|$)/, /^terraform\.tfstate/,
  /^(auth|credentials?|secrets?)(\.(json|ya?ml|toml|ini|txt|env|xml|cfg|conf|enc|properties))*$/,
  /service[-_]?account.*\.json$/, /^firebase-adminsdk.*\.json$/,
];

function mayHoldCredentials(inside: string): boolean {
  // Compare what the file system would open: macOS reads a long s as an s, and ignores case.
  const parts = inside.split(sep).map((part) => part.normalize("NFKC").toLowerCase());
  const name = parts.at(-1) ?? "";
  return parts.some((part) => SECRET_FOLDERS.has(part))
    || SECRET_NAMES.some((rule) => rule.test(name))
    || !executionApprovalProjectionPathsAreSafe([parts.join("/")]);
}

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
          bytes = await this.copy(workspace, requested, target);
          created.push(target);
        }
        const name = attachmentName(requested);
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

  private async copy(workspace: string, requested: string, target: string): Promise<Buffer> {
    const candidate = resolve(workspace, requested);
    const real = await realpath(candidate).catch(() => {
      throw new Error(`${requested} does not exist in your workspace.`);
    });
    const inside = relative(workspace, real);
    if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
      throw new Error(`${requested} is outside your workspace. Attach only files inside it.`);
    }
    if (mayHoldCredentials(inside)) {
      throw new Error(`${requested} may hold credentials, so it is never attached.`);
    }
    if (!(await stat(real)).isFile()) throw new Error(`${requested} is not a regular file.`);
    // `real` has no symlink left in it, and the open refuses one anywhere in the
    // path: what is opened is the file at that inside path at this moment.
    const handle = await open(real, READ_FLAGS).catch((error: NodeJS.ErrnoException) => {
      throw new Error(error.code === "ELOOP"
        ? `${requested} changed while it was being attached. Try again.`
        : `${requested} could not be read.`);
    });
    let bytes: Buffer;
    try {
      bytes = await readRegularFile(handle, requested);
    } finally {
      await handle.close();
    }
    const temporary = `${target}.${randomUUID()}.partial`;
    await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
    await rename(temporary, target);
    return bytes;
  }
}

/**
 * Read exactly the size the open file had: a file that grows during the read is
 * refused instead of read without bound, and a named pipe never blocks.
 */
async function readRegularFile(handle: FileHandle, requested: string): Promise<Buffer> {
  const info = await handle.stat();
  if (!info.isFile()) throw new Error(`${requested} is not a regular file.`);
  // A hard link can name a file from outside the workspace under an inside path.
  if (info.nlink > 1) throw new Error(`${requested} is a hard link, so it is not attached.`);
  if (info.size === 0) throw new Error(`${requested} is empty.`);
  if (info.size > MESSAGE_ATTACHMENT_LIMITS.maxFileBytes) {
    throw new Error(`${requested} is larger than ${formatMessageAttachmentLimit(MESSAGE_ATTACHMENT_LIMITS.maxFileBytes)}.`);
  }
  const bytes = Buffer.alloc(info.size);
  let offset = 0;
  while (offset < info.size) {
    const { bytesRead } = await handle.read(bytes, offset, info.size - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  const { bytesRead: beyond } = await handle.read(Buffer.alloc(1), 0, 1, info.size);
  if (offset !== info.size || beyond !== 0) throw new Error(`${requested} changed while it was being attached. Try again.`);
  return bytes;
}

/** A spool copy is trusted only as a regular, singly linked file the daemon wrote. */
async function readSpoolCopy(path: string): Promise<Buffer | null> {
  const handle = await open(path, READ_FLAGS).catch(() => null);
  if (!handle) return null;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > MESSAGE_ATTACHMENT_LIMITS.maxFileBytes) return null;
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function attachmentName(requested: string): string {
  const name = basename(requested.replace(/\\/g, "/")).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 160).trim();
  return name || "attachment";
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
