import { LETAGENTS_ROOM_ORIGIN } from "./room-urls";

const INVITE_CODE_PATTERN = /^[A-Z0-9]{4}(?:-[A-Z0-9]{4})+$/;

export function looksLikeInviteCode(value: string): boolean {
  return INVITE_CODE_PATTERN.test(value.trim().toUpperCase());
}

/**
 * Normalize paste-friendly join input: invite codes or LetAgents room URLs.
 * Returns null when the value is empty after trimming.
 */
export function normalizeJoinRoomInput(
  raw: string,
  origin = LETAGENTS_ROOM_ORIGIN,
): string | null {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return null;

  const withoutSpaces = trimmed.replace(/\s+/g, "");
  const fromUrl = extractRoomIdentifierFromUrl(withoutSpaces, origin);
  const candidate = (fromUrl || withoutSpaces).replace(/^\/+|\/+$/g, "");

  if (!candidate) return null;

  if (looksLikeInviteCode(candidate)) {
    return candidate.toUpperCase().replace(/-+/g, "-");
  }

  // Soft-normalize near-invite codes only (letters/digits/hyphens), not room paths/URLs.
  if (/^[A-Za-z0-9-]+$/.test(candidate)) {
    const compact = candidate.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (/^[A-Z0-9]{8,}$/.test(compact) && compact.length % 4 === 0) {
      const grouped = compact.match(/.{1,4}/g)?.join("-") || compact;
      if (looksLikeInviteCode(grouped)) return grouped;
    }
  }

  return candidate;
}

export function validateJoinRoomInput(raw: string): {
  normalized: string | null;
  error: string | null;
} {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    return { normalized: null, error: "Enter an invite code or room URL." };
  }

  const withoutSpaces = trimmed.replace(/\s+/g, "");
  if (isAbsoluteHttpUrl(withoutSpaces)) {
    const fromUrl = extractRoomIdentifierFromUrl(withoutSpaces, LETAGENTS_ROOM_ORIGIN);
    if (!fromUrl) {
      return {
        normalized: null,
        error: "Use an invite code or a LetAgents room URL.",
      };
    }
  }

  const normalized = normalizeJoinRoomInput(raw);
  if (!normalized) {
    return { normalized: null, error: "Enter an invite code or room URL." };
  }
  return { normalized, error: null };
}

function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function extractRoomIdentifierFromUrl(value: string, origin: string): string | null {
  const normalizedOrigin = origin.replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    // Relative /in/... paths pasted without origin
    if (value.startsWith("/in/")) {
      return decodeRoomPath(value.slice("/in/".length));
    }
    if (value.toLowerCase().startsWith("in/")) {
      return decodeRoomPath(value.slice("in/".length));
    }
    return null;
  }

  const originMatches =
    parsed.origin === normalizedOrigin ||
    parsed.host === "letagents.chat" ||
    parsed.host.endsWith(".letagents.chat");
  if (!originMatches) return null;

  const path = parsed.pathname.replace(/^\/+|\/+$/g, "");
  if (!path.toLowerCase().startsWith("in/")) return null;
  return decodeRoomPath(path.slice("in/".length));
}

function decodeRoomPath(path: string): string {
  return path
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
