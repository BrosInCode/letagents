import type { RoomGif } from "../../../../../shared/room-expressions.mjs";
import { shallowRef } from "vue";
import type {
  DesktopOutgoingMessageAttachment,
  DesktopPersistedOutgoingMessage,
  DesktopRoomMessage,
} from "../../../electron/ipc-types";
import { desktopIpc } from "../ipc/index.js";

export interface OutgoingMessage {
  roomIdentifier: string;
  messageNamespace: string | null;
  clientMessageId: string;
  text: string;
  replyTo: string | null;
  threadRootId: string | null;
  attachments: DesktopOutgoingMessageAttachment[];
  gif?: RoomGif | null;
  message: DesktopRoomMessage;
  inFlight: boolean;
  confirmed: boolean;
  onConfirmed: (message: DesktopRoomMessage) => void;
}

export interface DesktopOutboxConfirmedEvent {
  roomIdentifier: string;
  messageNamespace: string | null;
  clientMessageId: string;
  message: DesktopRoomMessage;
}

type OutboxConfirmationListener = (event: DesktopOutboxConfirmedEvent) => void;

// App-session state: a room shell is remounted on every room switch. Keep
// accepted submissions here until the authoritative stream has caught up.
export const desktopMessageOutbox = shallowRef<readonly OutgoingMessage[]>([]);

let outboxGeneration = 0;
const confirmationHandlers = new Map<string, { token: symbol; listener: OutboxConfirmationListener }>();

function roomOutboxKey(roomIdentifier: string, messageNamespace: string | null): string {
  return `${roomIdentifier}\0${messageNamespace ?? ""}`;
}

function changed(): void {
  desktopMessageOutbox.value = [...desktopMessageOutbox.value];
}

function normalizeAttachments(
  attachments: readonly DesktopOutgoingMessageAttachment[],
): DesktopOutgoingMessageAttachment[] {
  return attachments.map((attachment) => ({
    upload_id: attachment.upload_id,
    ...(attachment.fileName ? { fileName: attachment.fileName } : {}),
    ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
    ...(typeof attachment.sizeBytes === "number" ? { sizeBytes: attachment.sizeBytes } : {}),
  }));
}

function outgoingMeta(
  status: "pending" | "uncertain",
  attachments: readonly DesktopOutgoingMessageAttachment[],
  error: string | null,
): NonNullable<DesktopRoomMessage["outgoing"]> {
  return {
    status,
    attachmentCount: attachments.length,
    ...(attachments.length > 0 ? { attachments: normalizeAttachments(attachments) } : {}),
    error,
  };
}

function buildOutgoingMessage(input: {
  clientMessageId: string;
  text: string;
  replyTo: string | null;
  threadRootId: string | null;
  attachments: readonly DesktopOutgoingMessageAttachment[];
  gif?: RoomGif | null;
  replyPreview: DesktopRoomMessage["replyTo"];
  sender?: string;
  timestamp: string;
  status: "pending" | "uncertain";
  error: string | null;
}): DesktopRoomMessage {
  const id = `pending:${input.clientMessageId}`;
  return {
    id,
    clientMessageId: input.clientMessageId,
    sender: input.sender || "You",
    text: input.text,
    ...(input.gif ? { gif: input.gif } : {}),
    attachments: [],
    agentPromptKind: null,
    source: "browser",
    timestamp: input.timestamp,
    actorLabel: null,
    agentIdentity: null,
    threadRootId: input.threadRootId || id,
    threadReplyToId: input.replyTo,
    thread: null,
    replyTo: input.replyPreview,
    outgoing: outgoingMeta(input.status, input.attachments, input.error),
  };
}

export function registerDesktopOutboxConfirmationListener(
  roomIdentifier: string,
  messageNamespace: string | null,
  listener: OutboxConfirmationListener,
): () => void {
  const key = roomOutboxKey(roomIdentifier, messageNamespace);
  const token = Symbol(key);
  confirmationHandlers.set(key, { token, listener });
  return () => {
    if (confirmationHandlers.get(key)?.token === token) {
      confirmationHandlers.delete(key);
    }
  };
}

export function clearDesktopMessageOutbox(): void {
  outboxGeneration += 1;
  desktopMessageOutbox.value = [];
}

export async function hydrateDesktopMessageOutbox(): Promise<void> {
  if (typeof desktopIpc.room?.listOutgoingMessages !== "function") return;
  const generation = outboxGeneration;
  let persisted: DesktopPersistedOutgoingMessage[];
  try {
    persisted = await desktopIpc.room.listOutgoingMessages();
  } catch {
    return;
  }
  if (generation !== outboxGeneration || !Array.isArray(persisted) || persisted.length === 0) return;

  const existingIds = new Set(desktopMessageOutbox.value.map((entry) => entry.clientMessageId));
  const restored: OutgoingMessage[] = [];
  for (const item of persisted) {
    if (!item?.clientMessageId || existingIds.has(item.clientMessageId)) continue;
    const attachments = normalizeAttachments(item.attachments || []);
    restored.push({
      roomIdentifier: item.roomIdentifier,
      messageNamespace: item.messageNamespace ?? null,
      clientMessageId: item.clientMessageId,
      text: item.text,
      replyTo: item.replyTo ?? null,
      threadRootId: item.threadRootId ?? null,
      attachments,
      ...(item.gif ? { gif: item.gif } : {}),
      inFlight: false,
      confirmed: false,
      onConfirmed: () => undefined,
      message: buildOutgoingMessage({
        clientMessageId: item.clientMessageId,
        text: item.text,
        replyTo: item.replyTo ?? null,
        threadRootId: item.threadRootId ?? null,
        attachments,
        gif: item.gif,
        replyPreview: item.replyPreview ?? null,
        sender: item.sender || "You",
        timestamp: item.timestamp || new Date().toISOString(),
        status: item.status === "pending" ? "pending" : "uncertain",
        error: item.error ?? null,
      }),
    });
  }
  if (restored.length === 0) return;
  desktopMessageOutbox.value = [...restored, ...desktopMessageOutbox.value];
}

export function reconcileDesktopMessageOutbox(
  roomIdentifier: string,
  messages: readonly DesktopRoomMessage[],
  messageNamespace: string | null = null,
): void {
  const byClientId = new Map(
    messages
      .filter((message) => message.clientMessageId)
      .map((message) => [message.clientMessageId, message]),
  );
  desktopMessageOutbox.value = desktopMessageOutbox.value.filter((entry) => {
    if (entry.roomIdentifier !== roomIdentifier || entry.messageNamespace !== messageNamespace) return true;
    const message = byClientId.get(entry.clientMessageId);
    if (!message) return true;
    confirm(entry, message);
    return false;
  });
}

function confirm(entry: OutgoingMessage, message: DesktopRoomMessage): void {
  if (entry.confirmed) return;
  entry.confirmed = true;
  entry.message = message;
  void desktopIpc.room?.deleteOutgoingMessage?.(entry.clientMessageId).catch(() => undefined);
  entry.onConfirmed(message);
  const handler = confirmationHandlers.get(roomOutboxKey(entry.roomIdentifier, entry.messageNamespace));
  handler?.listener({
    roomIdentifier: entry.roomIdentifier,
    messageNamespace: entry.messageNamespace,
    clientMessageId: entry.clientMessageId,
    message,
  });
}

export interface EnqueueDesktopMessageInput {
  roomIdentifier: string;
  messageNamespace: string | null;
  text: string;
  replyTo: string | null;
  threadRootId: string | null;
  attachments: DesktopOutgoingMessageAttachment[];
  gif?: RoomGif | null;
  replyPreview: DesktopRoomMessage["replyTo"];
  onConfirmed: (message: DesktopRoomMessage) => void;
  clientMessageId?: string;
  timestamp?: string;
}

export function enqueueDesktopMessage(input: EnqueueDesktopMessageInput): string {
  const clientMessageId = input.clientMessageId || `desktop-send:${crypto.randomUUID()}`;
  const timestamp = input.timestamp || new Date().toISOString();
  const attachments = normalizeAttachments(input.attachments);
  const entry: OutgoingMessage = {
    roomIdentifier: input.roomIdentifier,
    messageNamespace: input.messageNamespace,
    text: input.text,
    replyTo: input.replyTo,
    threadRootId: input.threadRootId,
    attachments,
    ...(input.gif ? { gif: input.gif } : {}),
    onConfirmed: input.onConfirmed,
    clientMessageId,
    inFlight: false,
    confirmed: false,
    message: buildOutgoingMessage({
      clientMessageId,
      text: input.text,
      replyTo: input.replyTo,
      threadRootId: input.threadRootId,
      attachments,
      gif: input.gif,
      replyPreview: input.replyPreview,
      timestamp,
      status: "pending",
      error: null,
    }),
  };
  desktopMessageOutbox.value = [...desktopMessageOutbox.value, entry];
  return clientMessageId;
}

/**
 * Durably persist an outgoing send before the composer clears. If the app is
 * killed at any point after this resolves, reopening restores the send.
 */
export async function persistAndEnqueueDesktopMessage(
  input: EnqueueDesktopMessageInput,
): Promise<string | null> {
  const clientMessageId = input.clientMessageId || `desktop-send:${crypto.randomUUID()}`;
  const timestamp = input.timestamp || new Date().toISOString();
  const attachments = normalizeAttachments(input.attachments);
  const generation = outboxGeneration;
  const saveOutgoingMessage = desktopIpc.room?.saveOutgoingMessage;
  if (typeof saveOutgoingMessage === "function") {
    await saveOutgoingMessage({
      clientMessageId,
      roomIdentifier: input.roomIdentifier,
      messageNamespace: input.messageNamespace,
      text: input.text,
      replyTo: input.replyTo,
      threadRootId: input.threadRootId,
      attachments,
      ...(input.gif ? { gif: input.gif } : {}),
      replyPreview: input.replyPreview,
      timestamp,
    });
    if (generation !== outboxGeneration) {
      return null;
    }
  }
  return enqueueDesktopMessage({
    ...input,
    attachments,
    clientMessageId,
    timestamp,
  });
}

export async function retryDesktopOutgoingMessage(clientMessageId: string): Promise<void> {
  const entry = desktopMessageOutbox.value.find((item) => item.clientMessageId === clientMessageId);
  if (!entry || entry.inFlight || entry.confirmed) return;
  entry.inFlight = true;
  entry.message = { ...entry.message, outgoing: outgoingMeta("pending", entry.attachments, null) };
  changed();
  void desktopIpc.room?.updateOutgoingMessage?.(clientMessageId, {
    status: "pending",
    error: null,
  }).catch(() => undefined);
  try {
    const wireAttachments = entry.attachments.map(({ upload_id }) => ({ upload_id }));
    const result = await desktopIpc.room.sendMessage(
      entry.roomIdentifier,
      entry.text,
      entry.replyTo,
      wireAttachments,
      entry.threadRootId,
      entry.clientMessageId,
      entry.messageNamespace,
      entry.gif,
    );
    // Sign-out or a stream acknowledgement may have removed the entry.
    if (!desktopMessageOutbox.value.includes(entry)) return;
    confirm(entry, { ...result.message, clientMessageId: entry.clientMessageId });
  } catch (error) {
    if (!desktopMessageOutbox.value.includes(entry) || entry.confirmed) return;
    // IPC/network failures cannot establish whether the server committed. A
    // retry uses the same identity, never a second logical message.
    const message = error instanceof Error ? error.message : "Could not confirm delivery.";
    entry.message = {
      ...entry.message,
      outgoing: outgoingMeta("uncertain", entry.attachments, message),
    };
    void desktopIpc.room?.updateOutgoingMessage?.(clientMessageId, {
      status: "uncertain",
      error: message,
    }).catch(() => undefined);
  } finally {
    entry.inFlight = false;
    changed();
  }
}

/** Only a known pre-commit refusal permits changing an accepted send. */
export async function sendDesktopOutgoingWithoutGif(clientMessageId: string): Promise<void> {
  const entry = desktopMessageOutbox.value.find((item) => item.clientMessageId === clientMessageId);
  if (
    !entry
    || entry.inFlight
    || entry.confirmed
    || !entry.gif
    || (!entry.text.trim() && !entry.attachments.length)
    || !entry.message.outgoing?.error?.includes("expressions_disabled:")
  ) {
    return;
  }
  entry.gif = null;
  entry.message = { ...entry.message, gif: null };
  void desktopIpc.room?.updateOutgoingMessage?.(clientMessageId, { gif: null }).catch(() => undefined);
  await retryDesktopOutgoingMessage(clientMessageId);
}

/** An explicitly refused GIF-only send is safe to discard; an uncertain send is not. */
export function discardRefusedDesktopGif(clientMessageId: string): void {
  const entry = desktopMessageOutbox.value.find((item) => item.clientMessageId === clientMessageId);
  if (
    !entry
    || entry.inFlight
    || entry.confirmed
    || !entry.gif
    || Boolean(entry.text.trim())
    || entry.attachments.length > 0
    || !entry.message.outgoing?.error?.includes("expressions_disabled:")
  ) {
    return;
  }
  desktopMessageOutbox.value = desktopMessageOutbox.value.filter(
    (item) => item.clientMessageId !== clientMessageId,
  );
  void desktopIpc.room?.deleteOutgoingMessage?.(clientMessageId).catch(() => undefined);
}
