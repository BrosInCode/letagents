import type { InjectionKey, Ref } from "vue";

import type { DesktopAgentPresence, DesktopParticipantSummary } from "../../../electron/ipc-types";
import type { AgentModalTarget } from "../components/desktop/content/desktop-chat-message/types";
import { resolveOwnerAttribution } from "../components/desktop/content/desktop-chat-message/identity";
import type { PersonMenuPosition } from "./person-context-menu";
import type { PersonTarget } from "./person-target";

/** A room participant that a rendered @mention opens. */
export type RoomMentionTarget =
  | { kind: "agent"; key: string; displayName: string; agent: AgentModalTarget }
  | { kind: "human"; key: string; displayName: string; person: PersonTarget };

export interface RoomMentionDirectory {
  /** The one participant a handle names, or null when it names none or several. */
  resolve(handle: string): RoomMentionTarget | null;
  /** The participant behind a rendered mention's key. Rendered HTML is never the authority. */
  byKey(key: string): RoomMentionTarget | null;
}

export const roomMentionDirectoryKey: InjectionKey<Readonly<Ref<RoomMentionDirectory>>> =
  Symbol("room-mention-directory");

// Handles that address the whole room never open one profile.
const BROADCAST_HANDLES = new Set(["everyone", "here", "room", "agents", "all", "channel"]);
const AMBIGUOUS = null;

type AgentSource = Pick<DesktopParticipantSummary, "displayName" | "actorLabel" | "agentKey" | "ownerLabel" | "ideLabel">
  & { agentSessionId?: string | null };

function normalizeHandle(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function agentTarget(source: AgentSource, agentKey: string): AgentModalTarget {
  const displayName = source.displayName.split("|")[0]!.trim() || agentKey.split("/").at(-1) || "Agent";
  return {
    messageId: null,
    clientMessageId: null,
    messageSource: "agent",
    actorLabel: source.actorLabel ?? null,
    displayName,
    ownerAttribution: resolveOwnerAttribution(source),
    ideLabel: source.ideLabel ?? null,
    sender: source.actorLabel || displayName,
    agentKey,
    agentSessionId: source.agentSessionId ?? null,
  };
}

/**
 * Index the room's participants by every handle a message may use for them: an
 * agent by display name, durable key (`owner/name`), last key segment and
 * `agent:<key>`; a person by GitHub login and display name. A handle that names
 * two participants resolves to nothing, so a click never opens the wrong one.
 */
export function buildRoomMentionDirectory(
  participants: readonly DesktopParticipantSummary[],
  presence: readonly Pick<DesktopAgentPresence, "displayName" | "actorLabel" | "agentKey" | "ownerLabel" | "ideLabel" | "agentSessionId">[] = [],
): RoomMentionDirectory {
  const targets = new Map<string, RoomMentionTarget>();
  const aliases = new Map<string, string | typeof AMBIGUOUS>();
  const addAlias = (alias: string, key: string) => {
    const normalized = normalizeHandle(alias);
    if (!normalized || BROADCAST_HANDLES.has(normalized) || normalized === "anonymous") return;
    const existing = aliases.get(normalized);
    if (existing === undefined) aliases.set(normalized, key);
    else if (existing !== key) aliases.set(normalized, AMBIGUOUS);
  };

  const addAgent = (source: AgentSource) => {
    const agentKey = source.agentKey?.trim();
    if (!agentKey) return;
    const key = `agent:${agentKey.toLowerCase()}`;
    const existing = targets.get(key);
    // Presence knows the live session; keep it when the participant row does not.
    if (!existing || (existing.kind === "agent" && !existing.agent.agentSessionId && source.agentSessionId)) {
      const agent = agentTarget(source, agentKey);
      targets.set(key, { kind: "agent", key, displayName: agent.displayName, agent });
    }
    addAlias(source.displayName.split("|")[0]!, key);
    addAlias(agentKey, key);
    addAlias(agentKey.split("/").at(-1)!, key);
    addAlias(`agent:${agentKey}`, key);
  };

  for (const participant of participants) {
    if (participant.kind === "agent") {
      addAgent(participant);
      continue;
    }
    const login = participant.githubLogin?.trim();
    if (!login || normalizeHandle(login) === "anonymous") continue;
    const key = `human:${login.toLowerCase()}`;
    const displayName = participant.displayName.trim() || login;
    if (!targets.has(key)) {
      targets.set(key, { kind: "human", key, displayName, person: { login, displayName, avatarUrl: null } });
    }
    addAlias(login, key);
    addAlias(displayName, key);
  }
  for (const agent of presence) addAgent(agent);

  const resolved = new Map<string, RoomMentionTarget | null>();
  return {
    resolve(handle) {
      const normalized = normalizeHandle(handle);
      if (resolved.has(normalized)) return resolved.get(normalized)!;
      const key = aliases.get(normalized);
      const target = key ? targets.get(key) ?? null : null;
      resolved.set(normalized, target);
      return target;
    },
    byKey(key) {
      return targets.get(key) ?? null;
    },
  };
}

export const EMPTY_ROOM_MENTION_DIRECTORY: RoomMentionDirectory = {
  resolve: () => null,
  byKey: () => null,
};

const MENTION_SPAN = /<span class="mention-token">@([A-Za-z0-9._:/-]+)<\/span>/g;

/** True when the HTML holds a rendered @mention at all, so other messages skip the pass. */
export function mayContainMention(html: string): boolean {
  return html.includes('<span class="mention-token">');
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Turn rendered mentions of known participants into buttons. Decorate only HTML
 * already escaped and sanitized by renderMessageText. The renderer emits mention
 * spans only outside code, so code stays literal. Trailing punctuation the
 * renderer kept in the handle ("@Ana." or "@Ana:") stays outside the button.
 */
export function linkRenderedMentions(html: string, directory: RoomMentionDirectory): string {
  if (!mayContainMention(html)) return html;
  return html.replace(MENTION_SPAN, (match, handle: string) => {
    let name = handle;
    let target = directory.resolve(name);
    if (!target) {
      name = handle.replace(/[.:_-]+$/, "");
      target = name && name !== handle ? directory.resolve(name) : null;
    }
    if (!target) return match;
    const trailing = handle.slice(name.length);
    const label = target.kind === "agent" ? `Open ${target.displayName}` : `Open ${target.displayName}'s profile`;
    return [
      '<button class="mention-token mention-link" type="button"',
      ` data-mention-key="${escapeAttr(target.key)}"`,
      ` data-mention-kind="${target.kind}"`,
      ` title="${escapeAttr(label)}">`,
      `@${name}`,
      "</button>",
      trailing,
    ].join("");
  });
}

/** The clicked mention's key, or null when this click must not open a profile. */
export function mentionKeyForClick(event: {
  target: EventTarget | null;
  button?: number;
  detail?: number;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}, selectedText: string): string | null {
  const element = event.target && typeof (event.target as Element).closest === "function"
    ? (event.target as Element).closest<HTMLElement>("[data-mention-key]")
    : null;
  if (!element) return null;
  // Only a plain primary click opens. Shift-click extends a selection and the
  // other modifiers keep their usual meaning.
  if ((event.button ?? 0) !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  // A drag that selected text ends in a click; it must not open a profile. A
  // keyboard click (Enter or Space on the focused button) has detail 0 and opens
  // whatever text is selected elsewhere.
  if ((event.detail ?? 1) > 0 && selectedText.trim()) return null;
  return element.dataset.mentionKey || null;
}

/** Where a person menu opens for a mention: the pointer, or the mention's corner for a keyboard click. */
export function mentionMenuPosition(event: MouseEvent, element: Element | null): PersonMenuPosition {
  if (event.detail > 0) return { x: event.clientX, y: event.clientY };
  const rect = element?.getBoundingClientRect?.();
  return rect ? { x: rect.left, y: rect.bottom } : { x: 16, y: 16 };
}
