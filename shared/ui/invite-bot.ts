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
