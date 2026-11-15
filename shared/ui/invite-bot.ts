/**
 * "Invite a bot": one paste-able message a room member hands to a friend, who
 * pastes it to their own bot (Grok Bot, ChatGPT, Claude or another MCP
 * client). The bot then connects to LetAgents, joins the room and is guided by
 * the tool answers from there. The texts are pure functions of the room, so
 * the desktop and web apps show one message and the tests check it without a
 * DOM.
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
export const INVITE_BOT_HINT = "Send this to the bot's owner. They paste it to their bot.";
/** For a room admin of a members-only room: what to do when the bot asks to join. */
export const INVITE_BOT_APPROVE_HINT = "When the bot asks to join, approve it under Requests.";

/** The connector address on the LetAgents server that serves this app. */
export const DEFAULT_INVITE_BOT_CONNECTOR_URL = "https://letagents.chat/mcp";

const ACCESS_LINE = "If the room asks you to request access, do it and tell me.";
const REPO_ROLE_LINE = "You need a role on that GitHub repository.";

export interface InviteBotRoom {
  /** The room id: the code of an ad-hoc room, or `github.com/owner/repo` for a Git Room. */
  roomId: string;
  /** The room's display name; shown after the id when it differs. */
  roomName?: string | null;
  /** Whether the room is tied to a GitHub repository (its GitHub roles decide who can open it). */
  gitRoom: boolean;
  /** `https://<this server>/mcp`; the public server when not given. */
  connectorUrl?: string | null;
}

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

const ROOM_NAME_MAX_LENGTH = 80;

/**
 * The room's name as the human line shows it: one line of plain text in
 * quotes. The name is text other people chose, so it is never put into the
 * sentence the bot executes; line breaks and control characters go, and a
 * double quote becomes a single one so the quotes stay closed.
 */
export function inviteBotRoomName(room: Pick<InviteBotRoom, "roomId" | "roomName">): string | null {
  const name = (room.roomName ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/"/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, ROOM_NAME_MAX_LENGTH);
  return name && name !== room.roomId.trim() ? name : null;
}

/** `For the room "Sky Owl":` and a line break, for the person; nothing when the name is the id. */
export function inviteBotRoomNameLine(room: Pick<InviteBotRoom, "roomId" | "roomName">): string {
  const name = inviteBotRoomName(room);
  return name ? `For the room "${name}":\n` : "";
}

function joinSentence(room: InviteBotRoom): string {
  const id = room.roomId.trim();
  return room.gitRoom
    ? `join the repository room ${id} and say hi.`
    : `join the room ${id} and say hi.`;
}

function closingLine(room: InviteBotRoom): string {
  return room.gitRoom ? REPO_ROLE_LINE : ACCESS_LINE;
}

/**
 * The message for one platform. A first line for the person names the room
 * when it has a name; the rest names the connector address and the room id,
 * then says what the bot does. The sentence the bot executes carries the id
 * only, never the name. A Git Room's message names the repository room and
 * the GitHub role it needs; an ad-hoc room's tells the bot to ask for access
 * when the room is for members only, so the inviter can let it in.
 */
export function buildInviteBotMessage(platform: InviteBotPlatform, room: InviteBotRoom): string {
  const connector = room.connectorUrl?.trim() || DEFAULT_INVITE_BOT_CONNECTOR_URL;
  const id = room.roomId.trim();
  const named = inviteBotRoomNameLine(room);
  const join = joinSentence(room);
  const closing = closingLine(room);
  const kind = room.gitRoom ? "repository room" : "room";
  switch (platform) {
    case "grok":
      return `${named}Paste this to your Grok Bot:\nConnect to LetAgents at ${connector} and sign me in. Then ${join} ${closing}`;
    case "chatgpt":
      return `${named}In ChatGPT, add a custom connector with the URL ${connector} (sign in with GitHub when it asks). `
        + `Then tell ChatGPT: Join the LetAgents ${kind} ${id} and say hi. ${closing}`;
    case "claude":
      return `${named}In Claude, add the connector ${connector} (Settings → Connectors) and sign in. `
        + `Then tell Claude: Join the LetAgents ${kind} ${id} and say hi. ${closing}`;
    case "other":
      return `${named}Connector address: ${connector} (sign in with GitHub when it asks).\n`
        + `${room.gitRoom ? "Repository room" : "Room code"}: ${id}.\n`
        + `Tell your bot to ${join} ${closing}`;
  }
}

export interface InviteBotOptions {
  room: Ref<InviteBotRoom>;
  /** Writes the message to the clipboard; the browser clipboard when not given. */
  writeClipboard?: (text: string) => Promise<void>;
  /** How long "Copied" shows, in ms. */
  copiedMs?: number;
  /** Start with this bot picked (deep links and tests). */
  initialPlatform?: InviteBotPlatform | null;
}

/**
 * The section's state: closed, or open with the picker, or open with a bot
 * picked and its message shown. Copying never changes the picked bot.
 */
export function useInviteBot(options: InviteBotOptions) {
  const platform = ref<InviteBotPlatform | null>(options.initialPlatform ?? null);
  const open = ref(Boolean(options.initialPlatform));
  const copied = ref(false);
  const copyError = ref<string | null>(null);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  const writeClipboard = options.writeClipboard ?? ((text: string) => globalThis.navigator.clipboard.writeText(text));

  const message = computed(() => (platform.value ? buildInviteBotMessage(platform.value, options.room.value) : ""));

  function show(): void {
    open.value = true;
  }

  function pick(next: InviteBotPlatform): void {
    platform.value = next;
    copied.value = false;
    copyError.value = null;
  }

  function close(): void {
    open.value = false;
    platform.value = null;
    copied.value = false;
    copyError.value = null;
    clearTimeout(copiedTimer);
  }

  async function copy(): Promise<boolean> {
    const text = message.value;
    if (!text) return false;
    copyError.value = null;
    try {
      await writeClipboard(text);
      copied.value = true;
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => { copied.value = false; }, options.copiedMs ?? 1600);
      return true;
    } catch {
      copyError.value = "The message could not be copied. Select it and copy it by hand.";
      return false;
    }
  }

  return { open, platform, message, copied, copyError, show, pick, close, copy };
}

export type InviteBot = ReturnType<typeof useInviteBot>;

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
 */
export function useInviteBotCode(options: InviteBotCodeOptions) {
  const platform = ref<InviteBotPlatform>(options.initialPlatform ?? "grok");
  const created = ref<InviteBotCreated | null>(null);
  const busy = ref(false);
  const copied = ref(false);
  const error = ref<string | null>(null);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  const writeClipboard = options.writeClipboard ?? ((text: string) => globalThis.navigator.clipboard.writeText(text));

  const current = computed(() => {
    const made = created.value;
    const room = options.room.value;
    return made && room && made.invite.room_id === room.roomId && made.invite.platform === platform.value ? made : null;
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
    created.value = null;
    copied.value = false;
    error.value = null;
    busy.value = false;
    clearTimeout(copiedTimer);
  }

  /** Makes the code when there is none yet, then copies. Resolves the invite, or null on failure. */
  async function copy(): Promise<InviteBotCreated | null> {
    if (busy.value || !options.room.value) return null;
    error.value = null;
    let made = current.value;
    if (!made) {
      busy.value = true;
      try {
        made = await options.createInvite(platform.value);
        created.value = made;
      } catch (failure) {
        error.value = failure instanceof Error && failure.message ? failure.message : "The invite could not be made. Try again.";
        return null;
      } finally {
        busy.value = false;
      }
    }
    try {
      await writeClipboard(message.value.text);
    } catch {
      error.value = "The message could not be copied. Select it and copy it by hand.";
      return made;
    }
    copied.value = true;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { copied.value = false; }, options.copiedMs ?? 1600);
    return made;
  }

  return { platform, created: current, message, busy, copied, error, pick, reset, copy };
}

export type InviteBotCode = ReturnType<typeof useInviteBotCode>;
