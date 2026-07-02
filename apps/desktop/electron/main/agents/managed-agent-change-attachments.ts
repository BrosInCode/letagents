import { Buffer } from "node:buffer";

import type {
  DesktopManagedAgentChangeSummary,
  DesktopManagedAgentPublicChangeSummary,
} from "../../ipc-types.js";
import { MANAGED_AGENT_CHANGE_SUMMARY_ATTACHMENT_MIME } from "../../ipc-types.js";
import type { RoomMessageAttachmentPayload } from "../attachments.js";

export interface ManagedAgentChangeSummaryAttachmentDraft {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  buffer: Buffer;
  signature: string;
}

export function buildManagedAgentChangeSummaryAttachmentDraft(
  summary: DesktopManagedAgentChangeSummary | null,
): ManagedAgentChangeSummaryAttachmentDraft | null {
  if (!summary || summary.error || summary.changedFileCount <= 0) {
    return null;
  }

  const publicSummary = toPublicChangeSummary(summary);
  const json = JSON.stringify({
    kind: "managed_agent_change_summary",
    version: 1,
    summary: publicSummary,
  });
  const buffer = Buffer.from(json, "utf8");
  return {
    fileName: "agent-changes.json",
    mimeType: MANAGED_AGENT_CHANGE_SUMMARY_ATTACHMENT_MIME,
    sizeBytes: buffer.byteLength,
    buffer,
    signature: managedAgentChangeSummarySignature(summary),
  };
}

export function managedAgentChangeSummarySignature(
  summary: DesktopManagedAgentChangeSummary,
): string {
  return JSON.stringify({
    changedFileCount: summary.changedFileCount,
    stagedFileCount: summary.stagedFileCount,
    unstagedFileCount: summary.unstagedFileCount,
    untrackedFileCount: summary.untrackedFileCount,
    additions: summary.additions,
    deletions: summary.deletions,
    files: summary.files.map((file) => ({
      path: file.path,
      previousPath: file.previousPath,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      binary: file.binary,
      staged: file.staged,
      unstaged: file.unstaged,
      untracked: file.untracked,
    })),
    hiddenFileCount: summary.hiddenFileCount,
    error: summary.error,
  });
}

export function managedAgentChangeSummaryLocalAttachmentPayload(
  draft: ManagedAgentChangeSummaryAttachmentDraft,
): RoomMessageAttachmentPayload {
  return {
    id: "managed-agent-change-summary",
    name: "Agent changes",
    file_name: draft.fileName,
    mime_type: draft.mimeType,
    size_bytes: draft.sizeBytes,
    content_base64: draft.buffer.toString("base64"),
  };
}

function toPublicChangeSummary(
  summary: DesktopManagedAgentChangeSummary,
): DesktopManagedAgentPublicChangeSummary {
  return {
    providerId: summary.providerId,
    repoBranch: summary.repoBranch,
    changeScope: "working_tree",
    changedFileCount: summary.changedFileCount,
    stagedFileCount: summary.stagedFileCount,
    unstagedFileCount: summary.unstagedFileCount,
    untrackedFileCount: summary.untrackedFileCount,
    additions: summary.additions,
    deletions: summary.deletions,
    files: summary.files,
    hiddenFileCount: summary.hiddenFileCount,
    isGitRepo: summary.isGitRepo,
    updatedAt: summary.updatedAt,
    error: summary.error,
  };
}
