import type {
  DesktopManagedAgentPublicChangeSummary,
  DesktopManagedAgentSession,
  DesktopRoomStorageState,
  DesktopRoomStreamEvent,
} from "../../ipc-types.js";
import { stageDesktopAttachmentBuffer } from "../attachments.js";
import type { RoomMessageAttachmentPayload } from "../attachments.js";
import {
  buildManagedAgentChangeSummaryAttachmentDraft,
  managedAgentChangeSummaryLocalAttachmentPayload,
  managedAgentChangeSummarySignature,
  toPublicManagedAgentChangeSummary,
  type ManagedAgentChangeSummaryAttachmentDraft,
} from "./managed-agent-change-attachments.js";
import { publishManagedAgentChangeSummaryArtifact } from "./managed-agent-change-summary-artifacts.js";
import { buildDesktopManagedAgentChangeSummary } from "./managed-agent-changes.js";
import type { StoredAgentSessionState } from "./state.js";

type ManagedRoomEvent = Extract<DesktopRoomStreamEvent, { type: "message" | "task_update" }>;

export interface DesktopManagedAgentReplyChangeContext {
  summary: DesktopManagedAgentPublicChangeSummary | null;
  signature: string | null;
  attachmentDraft: ManagedAgentChangeSummaryAttachmentDraft | null;
}

const replyChangeAttachmentSignatures = new Map<string, string>();
const replyChangeArtifactPublishKeys = new Map<string, string>();

export function emptyDesktopManagedAgentReplyChangeContext(): DesktopManagedAgentReplyChangeContext {
  return {
    summary: null,
    signature: null,
    attachmentDraft: null,
  };
}

export async function buildDesktopManagedAgentReplyChangeContext(input: {
  sessionKey: string;
  session: DesktopManagedAgentSession;
  beforeSignature?: string | null;
}): Promise<DesktopManagedAgentReplyChangeContext> {
  try {
    const summary = await buildDesktopManagedAgentChangeSummary(input.session);
    const signature = managedAgentChangeSummarySignature(summary);
    const shouldAttach =
      !(input.beforeSignature && input.beforeSignature === signature) &&
      replyChangeAttachmentSignatures.get(input.sessionKey) !== signature;
    return {
      summary: toPublicManagedAgentChangeSummary(summary),
      signature,
      attachmentDraft: shouldAttach
        ? buildManagedAgentChangeSummaryAttachmentDraft(summary)
        : null,
    };
  } catch (error) {
    console.warn(
      "Could not build managed-agent working tree summary.",
      error instanceof Error ? error.message : String(error),
    );
    return emptyDesktopManagedAgentReplyChangeContext();
  }
}

export async function desktopManagedAgentReplyChangeSignature(
  session: DesktopManagedAgentSession,
): Promise<string | null> {
  try {
    const summary = await buildDesktopManagedAgentChangeSummary(session);
    return managedAgentChangeSummarySignature(summary);
  } catch (error) {
    console.warn(
      "Could not read managed-agent working tree signature.",
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

export function rememberDesktopManagedAgentReplyChangeAttachment(
  sessionKey: string,
  draft: ManagedAgentChangeSummaryAttachmentDraft | null,
): void {
  if (draft) {
    replyChangeAttachmentSignatures.set(sessionKey, draft.signature);
  }
}

export function localDesktopManagedAgentReplyChangeAttachments(
  context: DesktopManagedAgentReplyChangeContext,
): RoomMessageAttachmentPayload[] {
  return context.attachmentDraft
    ? [managedAgentChangeSummaryLocalAttachmentPayload(context.attachmentDraft)]
    : [];
}

export async function stageDesktopManagedAgentReplyChangeAttachment(
  cloudRoomIdentifier: string,
  draft: ManagedAgentChangeSummaryAttachmentDraft | null,
): Promise<Array<{ upload_id: string }>> {
  if (!draft) {
    return [];
  }

  try {
    const staged = await stageDesktopAttachmentBuffer(
      cloudRoomIdentifier,
      draft.buffer,
      draft.fileName,
      draft.mimeType,
    );
    return [{ upload_id: staged.uploadId }];
  } catch (error) {
    console.warn(
      "Could not upload managed-agent working tree summary attachment.",
      error instanceof Error ? error.message : String(error),
    );
    return [];
  }
}

export async function publishDesktopManagedAgentReplyChangeSummaryArtifact(input: {
  sessionKey: string;
  roomIdentifier: string;
  storage: DesktopRoomStorageState;
  workerSession: StoredAgentSessionState;
  event: ManagedRoomEvent;
  context: DesktopManagedAgentReplyChangeContext;
}): Promise<void> {
  if (!input.context.summary || !input.context.signature) {
    return;
  }
  const taskId = managedRoomEventTaskId(input.event);
  const publishKey = JSON.stringify({ signature: input.context.signature, taskId });
  if (replyChangeArtifactPublishKeys.get(input.sessionKey) === publishKey) {
    return;
  }
  try {
    await publishManagedAgentChangeSummaryArtifact({
      roomIdentifier: input.roomIdentifier,
      storage: input.storage,
      workerSession: input.workerSession,
      summary: input.context.summary,
      taskId,
    });
    replyChangeArtifactPublishKeys.set(input.sessionKey, publishKey);
  } catch (error) {
    console.warn(
      "Could not publish managed-agent change summary artifact.",
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function managedRoomEventTaskId(event: ManagedRoomEvent): string | null {
  return event.type === "task_update" ? event.task.id : null;
}

export function clearDesktopManagedAgentReplyChangeState(sessionKey: string): void {
  replyChangeAttachmentSignatures.delete(sessionKey);
  replyChangeArtifactPublishKeys.delete(sessionKey);
}

export function clearAllDesktopManagedAgentReplyChangeState(): void {
  replyChangeAttachmentSignatures.clear();
  replyChangeArtifactPublishKeys.clear();
}
