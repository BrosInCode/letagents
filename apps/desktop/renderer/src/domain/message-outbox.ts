import { shallowRef } from "vue";
import type { DesktopRoomMessage } from "../../../electron/ipc-types";
import { desktopIpc } from "../ipc/index.js";

interface OutgoingMessage {
  roomIdentifier: string;
  messageNamespace: string | null;
  clientMessageId: string;
  text: string;
  replyTo: string | null;
  threadRootId: string | null;
  attachments: Array<{ upload_id: string }>;
  message: DesktopRoomMessage;
  inFlight: boolean;
  confirmed: boolean;
  onConfirmed: (message: DesktopRoomMessage) => void;
}

// App-session state: a room shell is remounted on every room switch. Keep
// accepted submissions here until the authoritative stream has caught up.
export const desktopMessageOutbox = shallowRef<readonly OutgoingMessage[]>([]);

function changed(): void {
  desktopMessageOutbox.value = [...desktopMessageOutbox.value];
}

export function clearDesktopMessageOutbox(): void {
  desktopMessageOutbox.value = [];
}

export function reconcileDesktopMessageOutbox(roomIdentifier: string, messages: readonly DesktopRoomMessage[], messageNamespace: string | null = null): void {
  const byClientId = new Map(messages.filter(message => message.clientMessageId).map(message => [message.clientMessageId, message]));
  desktopMessageOutbox.value = desktopMessageOutbox.value.filter(entry => {
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
  entry.onConfirmed(message);
}

export function enqueueDesktopMessage(input: {
  roomIdentifier: string;
  messageNamespace: string | null;
  text: string;
  replyTo: string | null;
  threadRootId: string | null;
  attachments: Array<{ upload_id: string }>;
  replyPreview: DesktopRoomMessage["replyTo"];
  onConfirmed: (message: DesktopRoomMessage) => void;
}): string {
  const clientMessageId = `desktop-send:${crypto.randomUUID()}`;
  const id = `pending:${clientMessageId}`;
  const entry: OutgoingMessage = {
    ...input,
    attachments: input.attachments.map(attachment => ({ ...attachment })),
    clientMessageId,
    inFlight: false,
    confirmed: false,
    message: {
      id, clientMessageId, sender: "You", text: input.text,
      attachments: [], agentPromptKind: null, source: "browser",
      timestamp: new Date().toISOString(), actorLabel: null, agentIdentity: null,
      threadRootId: input.threadRootId || id, threadReplyToId: input.replyTo,
      thread: null, replyTo: input.replyPreview,
      outgoing: { status: "pending", attachmentCount: input.attachments.length, error: null },
    },
  };
  desktopMessageOutbox.value = [...desktopMessageOutbox.value, entry];
  return clientMessageId;
}

export async function retryDesktopOutgoingMessage(clientMessageId: string): Promise<void> {
  const entry = desktopMessageOutbox.value.find(item => item.clientMessageId === clientMessageId);
  if (!entry || entry.inFlight || entry.confirmed) return;
  entry.inFlight = true;
  entry.message = { ...entry.message, outgoing: { status: "pending", attachmentCount: entry.attachments.length, error: null } };
  changed();
  try {
    const result = await desktopIpc.room.sendMessage(
      entry.roomIdentifier, entry.text, entry.replyTo, entry.attachments, entry.threadRootId, entry.clientMessageId, entry.messageNamespace,
    );
    // Sign-out or a stream acknowledgement may have removed the entry.
    if (!desktopMessageOutbox.value.includes(entry)) return;
    confirm(entry, { ...result.message, clientMessageId: entry.clientMessageId });
  } catch (error) {
    if (!desktopMessageOutbox.value.includes(entry) || entry.confirmed) return;
    // IPC/network failures cannot establish whether the server committed. A
    // retry uses the same identity, never a second logical message.
    entry.message = { ...entry.message, outgoing: {
      status: "uncertain", attachmentCount: entry.attachments.length,
      error: error instanceof Error ? error.message : "Could not confirm delivery.",
    } };
  } finally {
    entry.inFlight = false;
    changed();
  }
}
