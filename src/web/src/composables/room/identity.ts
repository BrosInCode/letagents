import type {
  MessageReplyReference,
  RoomAgentPromptKind,
  RoomMessage,
} from './types'

export { getSenderColor } from '../../../../../shared/ui/sender-color'
import {
  ownerAttributionFromOwnerLabel,
  parseAgentLabel,
  type AgentLabel,
} from '../../../../../shared/ui/agent-label'

export type ParsedIdentity = AgentLabel

export function resolveAgentIdentity(
  sender: string,
  structured?: {
    display_name?: string | null
    owner_label?: string | null
    owner_attribution?: string | null
    ide_label?: string | null
    actor_label?: string | null
  } | null,
): ParsedIdentity {
  const parsed = parseAgentIdentity(sender)
  const ownerAttribution = structured?.owner_attribution
    || ownerAttributionFromOwnerLabel(structured?.owner_label)
    || parseAgentIdentity(structured?.actor_label || '').ownerAttribution
    || parsed.ownerAttribution
  return {
    ...parsed,
    displayName: structured?.display_name || parsed.displayName,
    ownerAttribution,
    ideLabel: structured?.ide_label || parsed.ideLabel,
    structured: Boolean(structured) || parsed.structured,
  }
}

export function parseAgentIdentity(sender: string): ParsedIdentity {
  return parseAgentLabel(sender)
}

export function isHumanSender(sender: string, source: string | null): boolean {
  const n = (sender || '').trim().toLowerCase()
  if (n === 'letagents' || n === 'system') return false
  if (source === 'browser') return true
  if (source === 'agent') return false
  if (n === 'human' || n === 'anonymous') return true
  const parsed = parseAgentIdentity(sender)
  return !!(parsed.structured || parsed.ownerAttribution || parsed.ideLabel)
    ? false
    : source === 'browser'
}

// SYNC: src/shared/room-agent-prompts.ts
export function normalizeAgentPromptKind(
  value: unknown,
): RoomAgentPromptKind | null {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
  return normalized === 'join' ||
    normalized === 'inline' ||
    normalized === 'auto'
    ? normalized
    : null
}

export function isPromptOnlyRoomMessage(
  message: Pick<RoomMessage, 'text' | 'agent_prompt_kind'> | null | undefined,
): boolean {
  return (
    normalizeAgentPromptKind(message?.agent_prompt_kind) === 'auto' &&
    !String(message?.text || '').trim()
  )
}

export function isVisibleRoomMessage(
  message: Pick<RoomMessage, 'text' | 'agent_prompt_kind'> | null | undefined,
): boolean {
  return !isPromptOnlyRoomMessage(message)
}

export function hasInlinePromptInjection(
  message: Pick<RoomMessage, 'agent_prompt_kind'> | null | undefined,
): boolean {
  return normalizeAgentPromptKind(message?.agent_prompt_kind) === 'inline'
}

export function getReplyPreviewText(
  reply: Pick<MessageReplyReference, 'text' | 'display_text'> | null | undefined,
): string {
  const text = String(reply?.display_text || reply?.text || '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > 160 ? `${text.slice(0, 157)}...` : text
}
