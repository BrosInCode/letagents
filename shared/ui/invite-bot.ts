/**
 * "Invite a bot": one paste-able message a room member hands to a bot's
 * owner, who pastes it to their bot (Grok Bot, ChatGPT, Claude or another MCP
 * client). The message names this server's connector address and a one-use
 * invite code; the bot connects, signs in and calls join_code with the code.
 * An admin's invite lets the bot in at once; a member's asks the admins.
 * The desktop composer panel, Room settings and the web room drawer show one
 * message from here, and the tests check it without a DOM.
 */
import { computed, ref, type Ref } from "vue";

export type InviteBotPlatform = "grok" | "chatgpt" | "claude" | "other";

export const INVITE_BOT_PLATFORMS: ReadonlyArray<{ id: InviteBotPlatform; label: string }> = [
  { id: "grok", label: "Grok Bot" },
  { id: "chatgpt", label: "ChatGPT" },
  { id: "claude", label: "Claude" },
  { id: "other", label: "Other" },
];

/** Under the message. */
export const INVITE_BOT_HINT = "Send this to the bot's owner.";
/** The connector address on the LetAgents server that serves this app. */
export const DEFAULT_INVITE_BOT_CONNECTOR_URL = "https://letagents.chat/mcp";

/** For a Git Room: bots join invite rooms, never a room a repository decides. */
export const INVITE_BOT_GIT_ROOM_LINE = "Bots join invite rooms, not Git Rooms.";

/** `https://letagents.chat/mcp` for the origin of the app that shows the message. */
export function inviteBotConnectorUrl(origin: string | null | undefined): string {
  const trimmed = origin?.trim().replace(/\/+$/, "");
  if (!trimmed) return DEFAULT_INVITE_BOT_CONNECTOR_URL;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return DEFAULT_INVITE_BOT_CONNECTOR_URL;
    return `${url.origin}/mcp`;
  } catch {
    return DEFAULT_INVITE_BOT_CONNECTOR_URL;
  }
}

// ── One-use invite codes ────────────────────────────────────────────────
//
// The message names the connector address and a one-use invite code. The
// code is made when the person presses Copy (so a panel opened and closed
// leaves no live code behind); until then the message shows a placeholder.
// The room's name is not in the message at all: the code names the room, and
// a name is text other people chose.

/** Shown where the code goes until Copy makes one. */
export const INVITE_CODE_PLACEHOLDER = "····-····";

export interface InviteBotCodeMessageInput {
  /** The one-use code, or null before Copy made one. */
  code: string | null;
  /** `https://<this server>/mcp`; the public server when not given. */
  connectorUrl?: string | null;
}

/** One piece of the message: plain text, the connector address, or the code. */
export type InviteBotMessagePart =
  | { kind: "text"; text: string }
  | { kind: "connector"; text: string }
  | { kind: "code"; text: string; placeholder: boolean };

export interface InviteBotCodeMessage {
  /** The line for the person: "Paste this to your Grok Bot:". */
  lead: string;
  /** The rest, in parts, so a host can mark the address and the code. */
  parts: InviteBotMessagePart[];
  /** Everything, as the clipboard gets it. */
  text: string;
}

const CODE_JOIN = "join LetAgents with the invite code";
const SAY_HI = "and say hi in the room.";

/**
 * The message for one platform, as parts and as text. Grok Bot gets one
 * paste; ChatGPT and Claude add a connector first; any other MCP client gets
 * the address and the code on their own lines.
 */
export function buildInviteBotCodeMessage(platform: InviteBotPlatform, input: InviteBotCodeMessageInput): InviteBotCodeMessage {
  const connector = input.connectorUrl?.trim() || DEFAULT_INVITE_BOT_CONNECTOR_URL;
  const code = input.code?.trim() || null;
  const t = (text: string): InviteBotMessagePart => ({ kind: "text", text });
  const address: InviteBotMessagePart = { kind: "connector", text: connector };
  const codePart: InviteBotMessagePart = { kind: "code", text: code ?? INVITE_CODE_PLACEHOLDER, placeholder: !code };
  let lead: string;
  let parts: InviteBotMessagePart[];
  switch (platform) {
    case "grok":
      lead = "Paste this to your Grok Bot:";
      parts = [t("Connect to LetAgents at "), address, t(` and sign me in. Then ${CODE_JOIN} `), codePart, t(` ${SAY_HI}`)];
      break;
    case "chatgpt":
      lead = "In ChatGPT, add a custom connector with this URL (sign in with GitHub when it asks):";
      parts = [address, t(`\nThen tell ChatGPT: Join LetAgents with the invite code `), codePart, t(` ${SAY_HI}`)];
      break;
    case "claude":
      lead = "In Claude, add this connector (Settings → Connectors) and sign in:";
      parts = [address, t(`\nThen tell Claude: Join LetAgents with the invite code `), codePart, t(` ${SAY_HI}`)];
      break;
    case "other":
      lead = "Add this connector address to your bot (sign in with GitHub when it asks):";
      parts = [address, t(`\nThen tell your bot to ${CODE_JOIN} `), codePart, t(` ${SAY_HI}`)];
      break;
  }
  const text = `${lead}\n${parts.map((part) => part.text).join("")}`;
  return { lead, parts, text };
}

/** What the invite does, in one line under the panel's title. */
export function inviteBotCodeSummary(roomName: string, admin: boolean): string {
  const name = roomName.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/"/g, "'").trim().slice(0, 80) || "this room";
  return admin
    ? `The bot joins "${name}" at once, with no approval. The invite works one time.`
    : `An admin of "${name}" lets the bot in. The invite works one time.`;
}

/** A made invite as the host's API returns it. */
export interface InviteBotCreated {
  invite: { id: string; platform: InviteBotPlatform; kind: "admit" | "request"; room_id: string };
  code: string;
}

export interface InviteBotCodeOptions {
  /** The room the bot joins, and the connector address. */
  room: Ref<{ roomId: string; roomName?: string | null; connectorUrl?: string | null } | null>;
  /** Makes the invite on the server. Throws an Error whose message is shown. */
  createInvite: (platform: InviteBotPlatform) => Promise<InviteBotCreated>;
  writeClipboard?: (text: string) => Promise<void>;
  copiedMs?: number;
  initialPlatform?: InviteBotPlatform | null;
}

/**
 * The invite panel's state: a picked bot (Grok Bot first), the message with
 * a placeholder, and Copy, which makes the code once for this room and bot and
 * copies the message. Copying again copies the same code. Another bot or room
 * starts over: the next Copy makes a new code.
 *
 * Copy copies the message for the bot and room picked when it was pressed,
 * with the code the server returned, even when the person picks another bot
 * while the code is being made. The made code is matched to the room the
 * panel asked for, not to the room the server names (a focus room's invite is
 * for its parent room).
 */
export function useInviteBotCode(options: InviteBotCodeOptions) {
  const platform = ref<InviteBotPlatform>(options.initialPlatform ?? "grok");
  const made = ref<{ forRoomId: string; platform: InviteBotPlatform; created: InviteBotCreated } | null>(null);
  const busy = ref(false);
  const copied = ref(false);
  const error = ref<string | null>(null);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  const writeClipboard = options.writeClipboard ?? ((text: string) => globalThis.navigator.clipboard.writeText(text));

  const current = computed(() => {
    const room = options.room.value;
    return made.value && room && made.value.forRoomId === room.roomId && made.value.platform === platform.value
      ? made.value.created
      : null;
  });
  const message = computed(() => buildInviteBotCodeMessage(platform.value, {
    code: current.value?.code ?? null,
    connectorUrl: options.room.value?.connectorUrl,
  }));

  function pick(next: InviteBotPlatform): void {
    platform.value = next;
    copied.value = false;
    error.value = null;
  }

  function reset(): void {
    made.value = null;
    copied.value = false;
    error.value = null;
    busy.value = false;
    clearTimeout(copiedTimer);
  }

  /** Makes the code when there is none yet, then copies. Resolves the invite, or null on failure. */
  async function copy(): Promise<InviteBotCreated | null> {
    const room = options.room.value;
    if (busy.value || !room) return null;
    error.value = null;
    // What the person asked for when they pressed Copy.
    const pickedPlatform = platform.value;
    const connectorUrl = room.connectorUrl;
    let created = current.value;
    if (!created) {
      busy.value = true;
      try {
        created = await options.createInvite(pickedPlatform);
        made.value = { forRoomId: room.roomId, platform: pickedPlatform, created };
      } catch (failure) {
        error.value = failure instanceof Error && failure.message ? failure.message : "The invite could not be made. Try again.";
        return null;
      } finally {
        busy.value = false;
      }
    }
    try {
      await writeClipboard(buildInviteBotCodeMessage(pickedPlatform, { code: created.code, connectorUrl }).text);
    } catch {
      error.value = "The message could not be copied. Select it and copy it by hand.";
      return created;
    }
    copied.value = platform.value === pickedPlatform;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { copied.value = false; }, options.copiedMs ?? 1600);
    return created;
  }

  return { platform, created: current, message, busy, copied, error, pick, reset, copy };
}

export type InviteBotCode = ReturnType<typeof useInviteBotCode>;
