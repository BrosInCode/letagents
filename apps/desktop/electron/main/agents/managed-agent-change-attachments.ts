import { Buffer } from "node:buffer";

import type { DesktopManagedAgentChangeSummary } from "../../ipc-types.js";
import type { RoomMessageAttachmentPayload } from "../attachments.js";

export const MANAGED_AGENT_CHANGE_SUMMARY_ATTACHMENT_MIME =
  "application/vnd.letagents.managed-agent-change-summary+json";

export interface ManagedAgentChangeSummaryAttachmentDraft {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  buffer: Buffer;
}

export function buildManagedAgentChangeSummaryAttachmentDraft(
  summary: DesktopManagedAgentChangeSummary | null,
): ManagedAgentChangeSummaryAttachmentDraft | null {
  if (!summary || summary.error || summary.changedFileCount <= 0) {
    return null;
  }

  const json = JSON.stringify({
    kind: "managed_agent_change_summary",
    version: 1,
    summary,
  });
  const buffer = Buffer.from(json, "utf8");
  return {
    fileName: "agent-changes.json",
    mimeType: MANAGED_AGENT_CHANGE_SUMMARY_ATTACHMENT_MIME,
    sizeBytes: buffer.byteLength,
    buffer,
  };
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
