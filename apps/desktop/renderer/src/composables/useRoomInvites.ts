import { computed, ref, shallowRef, type ComputedRef } from "vue";
import {
  parseRoomInvite,
  roomInvitePlatformLabel,
  type RoomInvite,
  type RoomInviteEvent,
  type RoomInvitePlatform,
} from "../../../../../shared/room-invites.mjs";
import { desktopIpc } from "../ipc/index.js";

/**
 * "Invite a bot": the invites this account made, for the pill above the
 * composer. The server keeps only a hash of each code, so the code this app
 * received when it made the invite is kept on this computer (local storage),
 * to copy the message again after a restart. On another device the pill
 * still shows, with Cancel only.
 *
 * The account activity stream tells every device of the maker when an invite
 * is made, cancelled or used. A bot that joins the room it was invited to
 * ends the pill there (the room shows its own line); a bot invited from a Git
 * Room to another room leaves a pill in the Git Room that says so.
 */

const CODES_KEY = "letagents.roomInviteCodes.v1";
const MAX_CODES = 100;

interface StoredCode { code: string; expiresAt: string }

function readCodes(): Record<string, StoredCode> {
  try {
    const raw = globalThis.localStorage?.getItem(CODES_KEY);
    const parsed = raw ? JSON.parse(raw) as unknown : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const now = Date.now();
    const kept: Record<string, StoredCode> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = value as Partial<StoredCode> | null;
      if (typeof entry?.code === "string" && typeof entry.expiresAt === "string" && Date.parse(entry.expiresAt) > now) {
        kept[id] = { code: entry.code, expiresAt: entry.expiresAt };
      }
    }
    return kept;
  } catch {
    return {};
  }
}

function writeCodes(codes: Record<string, StoredCode>): void {
  try {
    const entries = Object.entries(codes).slice(-MAX_CODES);
    globalThis.localStorage?.setItem(CODES_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // A private window or a full disk: the code then lives only until a reload.
  }
}

/** The room whose composer shows the invite's pill: where it was made. */
export function pillRoomOf(invite: Pick<RoomInvite, "room_id" | "origin_room_id">): string {
  return invite.origin_room_id ?? invite.room_id;
}

/** "Grok Bot", "ChatGPT", "Claude", or "your bot". */
export function inviteBotName(platform: RoomInvitePlatform): string {
  return platform === "other" ? "your bot" : roomInvitePlatformLabel(platform);
}

export type RoomInvitePillState = "waiting" | "joined" | "asked";

export interface RoomInvitePill {
  invite: RoomInvite;
  state: RoomInvitePillState;
  /** The invite is for another room than the one whose composer shows it. */
  elsewhere: boolean;
  /** The code, when this computer made the invite. */
  code: string | null;
}

/** The pill's words, before its buttons. */
export function roomInvitePillText(pill: RoomInvitePill): { main: string; muted: string } {
  const bot = inviteBotName(pill.invite.platform);
  const room = pill.invite.room_display_name || pill.invite.room_id;
  const Bot = bot.charAt(0).toUpperCase() + bot.slice(1);
  if (pill.state === "joined") return { main: `${Bot} joined ${room}`, muted: "" };
  if (pill.state === "asked") {
    return { main: pill.elsewhere ? `${Bot} asked to join ${room}` : `${Bot} asked to join`, muted: " · an admin decides" };
  }
  return { main: `Invite for ${bot}${pill.elsewhere ? ` to ${room}` : ""}`, muted: " · waiting for it to join" };
}

/** Read once a minute while a pill shows, so an invite that ends leaves without another change. */
const PILL_CLOCK_MS = 60_000;

export function createRoomInvites() {
  const invites = shallowRef<ReadonlyMap<string, RoomInvite>>(new Map());
  const now = ref(Date.now());
  let clock: ReturnType<typeof setInterval> | null = null;
  /** Counts changes, so a list read that started before one does not undo it. */
  let changes = 0;
  const codes = shallowRef<Record<string, StoredCode>>(readCodes());
  /** Used invites the person closed with Done or Open. */
  const closed = shallowRef<ReadonlySet<string>>(new Set());
  /** Invites this app saw used while it ran; only these show a "joined" or "asked" pill. */
  const seenUsed = shallowRef<ReadonlySet<string>>(new Set());
  /**
   * Invites made in a panel that is still open: their pill waits until the
   * panel closes ("Copied" shows first, then the pill takes over).
   */
  const held = new Map<string, RoomInvite>();

  function put(invite: RoomInvite): void {
    changes += 1;
    const next = new Map(invites.value);
    next.set(invite.id, invite);
    invites.value = next;
    if (invite.state !== "open" && codes.value[invite.id]) {
      const { [invite.id]: _gone, ...rest } = codes.value;
      codes.value = rest;
      writeCodes(rest);
    }
  }

  function rememberCode(invite: RoomInvite, code: string): void {
    const next = { ...codes.value, [invite.id]: { code, expiresAt: invite.expires_at } };
    codes.value = next;
    writeCodes(next);
  }

  /** Reads this account's open invites that show in the room. */
  async function load(roomIdentifier: string): Promise<void> {
    if (!roomIdentifier) return;
    const changesAtStart = changes;
    const result = await desktopIpc.roomInvites?.list(roomIdentifier).catch(() => null);
    if (!result?.ok) return;
    const listed = new Set(result.invites.map((invite) => invite.id));
    const next = new Map(invites.value);
    // An open invite for this room that the server no longer lists ended while
    // the app was not looking. Only when nothing changed during the read: an
    // invite made meanwhile is not in the list yet.
    if (changes === changesAtStart) {
      for (const [id, invite] of next) {
        if (invite.state === "open" && pillRoomOf(invite) === roomIdentifier && !listed.has(id)) next.delete(id);
      }
    }
    // A listed invite is open; it never brings back one this app already saw end.
    for (const invite of result.invites) {
      const known = next.get(invite.id);
      if (!held.has(invite.id) && (!known || known.state === "open")) next.set(invite.id, invite);
    }
    invites.value = next;
  }

  /** Makes an invite; keeps its code on this computer. Throws with a sentence to show. */
  async function create(roomIdentifier: string, platform: RoomInvitePlatform, originRoomIdentifier: string | null) {
    const api = desktopIpc.roomInvites;
    if (!api) throw new Error("Restart LetAgents Desktop to invite bots.");
    const result = await api.create(roomIdentifier, platform, originRoomIdentifier);
    if (!result.ok) throw new Error(result.message);
    rememberCode(result.invite, result.code);
    held.set(result.invite.id, result.invite);
    return { invite: result.invite, code: result.code };
  }

  /** The panel that made these invites closed: their pills show now. */
  function reveal(inviteIds: readonly string[]): void {
    for (const id of inviteIds) {
      const invite = held.get(id);
      if (!invite) continue;
      held.delete(id);
      put(invite);
    }
  }

  /** Ends an invite. Returns a sentence when it could not. */
  async function cancel(invite: RoomInvite): Promise<string | null> {
    const result = await desktopIpc.roomInvites?.cancel(invite.room_id, invite.id).catch(() => null);
    if (result?.ok) {
      put(result.invite);
      return null;
    }
    if (result && !result.ok && result.code === "INVITE_NOT_OPEN") {
      await load(pillRoomOf(invite));
      return null;
    }
    return result && !result.ok ? result.message : "The invite could not be cancelled. Try again.";
  }

  /** An invite change from the account activity stream. */
  function receive(event: RoomInviteEvent): void {
    const invite = parseRoomInvite(event.invite);
    if (!invite) return;
    if (invite.state === "used") {
      const next = new Set(seenUsed.value);
      next.add(invite.id);
      seenUsed.value = next;
    }
    if (held.has(invite.id)) {
      // Still in its panel: an open echo waits with it; an end shows at once.
      if (invite.state === "open") {
        held.set(invite.id, invite);
        return;
      }
      held.delete(invite.id);
    }
    put(invite);
  }

  /** Done, or Open <room>: the used invite's pill goes. */
  function close(inviteId: string): void {
    const next = new Set(closed.value);
    next.add(inviteId);
    closed.value = next;
  }

  function tick(): void {
    now.value = Date.now();
  }

  function pillFor(invite: RoomInvite, now: number): RoomInvitePill | null {
    const elsewhere = invite.origin_room_id !== null && invite.origin_room_id !== invite.room_id;
    if (invite.state === "open") {
      if (Date.parse(invite.expires_at) <= now) return null;
      return { invite, state: "waiting", elsewhere, code: codes.value[invite.id]?.code ?? null };
    }
    if (invite.state !== "used" || closed.value.has(invite.id) || !seenUsed.value.has(invite.id)) return null;
    // In the invite's own room an admitted bot needs no pill: the room shows the join line.
    if (invite.outcome === "admitted" && !elsewhere) return null;
    return { invite, state: invite.outcome === "requested" ? "asked" : "joined", elsewhere, code: null };
  }

  /** The pills above one room's composer, newest first. */
  function pills(roomIdentifier: () => string | null): ComputedRef<RoomInvitePill[]> {
    if (!clock && typeof setInterval === "function") {
      clock = setInterval(tick, PILL_CLOCK_MS);
      (clock as { unref?: () => void }).unref?.();
    }
    return computed(() => {
      const room = roomIdentifier();
      if (!room) return [];
      const at = now.value;
      return [...invites.value.values()]
        .filter((invite) => pillRoomOf(invite) === room)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map((invite) => pillFor(invite, at))
        .filter((pill): pill is RoomInvitePill => pill !== null);
    });
  }

  function reset(): void {
    held.clear();
    changes += 1;
    invites.value = new Map();
    closed.value = new Set();
    seenUsed.value = new Set();
  }

  /** Sign-out: the codes this computer kept go too. */
  function forgetCodes(): void {
    codes.value = {};
    try {
      globalThis.localStorage?.removeItem(CODES_KEY);
    } catch {
      // Nothing kept.
    }
  }

  return {
    invites, load, create, reveal, cancel, receive, close, pills, reset, forgetCodes, tick,
    codeFor: (id: string) => codes.value[id]?.code ?? null,
  };
}

export type RoomInvites = ReturnType<typeof createRoomInvites>;

export const roomInvites = createRoomInvites();
