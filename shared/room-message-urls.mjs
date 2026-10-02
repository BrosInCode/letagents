export const LETAGENTS_ROOM_ORIGIN = "https://letagents.chat";

export const MESSAGE_ID_PATTERN = /^msg_[1-9]\d*$/;

export function isValidMessageId(messageId) {
  return typeof messageId === "string" && MESSAGE_ID_PATTERN.test(messageId);
}

export function encodeRoomPathIdentifier(identifier) {
  return String(identifier ?? "")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export function decodeRoomPath(path) {
  return String(path ?? "")
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");
}

export function isLocalRoomIdentifier(identifier) {
  const value = String(identifier ?? "").trim();
  return /^local[_-]/i.test(value) || /^git-room:local:/i.test(value);
}

export function buildLetAgentsMessageUrl(
  roomIdentifier,
  messageId,
  origin = LETAGENTS_ROOM_ORIGIN,
) {
  const cleanId = String(messageId ?? "").trim();
  if (!isValidMessageId(cleanId)) {
    throw new Error(`Invalid message ID for permalink: ${messageId}`);
  }
  const cleanRoom = String(roomIdentifier ?? "").trim();
  if (!cleanRoom) {
    throw new Error("Room identifier is required for permalink.");
  }
  const base = origin ? origin.replace(/\/+$/, "") : "";
  return `${base}/in/${encodeRoomPathIdentifier(cleanRoom)}?message=${cleanId}`;
}

export function parseLetAgentsMessageUrl(
  rawUrl,
  configuredOrigin = LETAGENTS_ROOM_ORIGIN,
) {
  if (typeof rawUrl !== "string") return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  let parsed;
  let isRelative = false;
  try {
    parsed = new URL(trimmed);
  } catch {
    if (trimmed.startsWith("/in/") || trimmed.startsWith("in/")) {
      try {
        parsed = new URL(trimmed.startsWith("/") ? trimmed : `/${trimmed}`, "http://localhost");
        isRelative = true;
      } catch {
        return null;
      }
    } else {
      return null;
    }
  }

  if (!isRelative) {
    let normalizedConfiguredOrigin;
    try {
      normalizedConfiguredOrigin = new URL(configuredOrigin).origin.toLowerCase();
    } catch {
      normalizedConfiguredOrigin = String(configuredOrigin).replace(/\/+$/, "").toLowerCase();
    }
    if (parsed.origin.toLowerCase() !== normalizedConfiguredOrigin) {
      return null;
    }
  }

  const pathname = parsed.pathname.replace(/^\/+|\/+$/g, "");
  if (!pathname.startsWith("in/")) {
    return null;
  }
  const rawRoom = pathname.slice("in/".length);
  if (!rawRoom) return null;
  const roomIdentifier = decodeRoomPath(rawRoom);
  if (!roomIdentifier.trim()) return null;

  const rawMessageId = parsed.searchParams.get("message");
  const messageId = isValidMessageId(rawMessageId) ? rawMessageId.trim() : null;

  return {
    roomIdentifier,
    messageId,
  };
}

export function resolveSameRoomMessageReference(
  rawUrl,
  currentRoomIdentifier,
  configuredOrigin = LETAGENTS_ROOM_ORIGIN,
) {
  if (typeof rawUrl !== "string" || !currentRoomIdentifier) return null;
  const parsed = parseLetAgentsMessageUrl(rawUrl, configuredOrigin);
  if (!parsed?.messageId) return null;
  if (parsed.roomIdentifier.trim() !== String(currentRoomIdentifier).trim()) {
    return null;
  }
  return parsed.messageId;
}

