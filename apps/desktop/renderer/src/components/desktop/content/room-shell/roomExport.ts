import type {
  DesktopRoomInfo,
  DesktopRoomMessage,
} from "../../../../../../electron/ipc-types";
import { roomMessageVisibleText } from "../../../../domain/attention-response";

export function exportRoomChat(
  room: DesktopRoomInfo,
  messages: readonly DesktopRoomMessage[],
  agentNames: ReadonlyMap<string, string> | null = null,
): void {
  if (!messages.length) return;
  const lines = messages.map((message) =>
    `[${new Date(message.timestamp).toLocaleString()}] ${message.sender}: ${roomMessageVisibleText(message, agentNames)}`
  );
  const blob = new Blob([lines.join("\n")], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `letagents-${room.displayName.replace(/[^a-z0-9-]+/gi, "-").toLowerCase()}-${Date.now()}.txt`;
  anchor.click();
  URL.revokeObjectURL(url);
}
