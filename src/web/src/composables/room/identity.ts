import type {
  MessageReplyReference,
  RoomAgentPromptKind,
  RoomMessage,
} from './types'

export { getSenderColor } from '../../../../../shared/ui/sender-color'

export interface ParsedIdentity {
  raw: string
  displayName: string
  ownerAttribution: string | null
  ideLabel: string | null
  structured: boolean
}

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
  const structuredOwner = String(structured?.owner_label || '').trim()
  const actorOwner = parseAgentIdentity(structured?.actor_label || '').ownerAttribution
  const ownerAttribution = structured?.owner_attribution
    || (structuredOwner
      ? (/['’]s\s+agent$/i.test(structuredOwner) ? structuredOwner : `${structuredOwner}'s agent`)
      : null)
    || actorOwner
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
  const raw = (sender || '').trim()
  if (!raw)
    return {
      raw,
      displayName: raw,
      ownerAttribution: null,
      ideLabel: null,
      structured: false,
    }

  const parts = raw
    .split(' | ')
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length === 3 && /agent$/i.test(parts[1])) {
    return {
      raw,
      displayName: parts[0],
      ownerAttribution: parts[1],
      ideLabel: normalizeIdeLabel(parts[2]),
      structured: true,
    }
  }

  const legacy = raw.match(/^(.*?)\s*\(([^)]+agent)\)$/i)
  if (legacy) {
    return {
      raw,
      displayName: (legacy[1] || '').trim() || raw,
      ownerAttribution: (legacy[2] || '').trim() || null,
      ideLabel: inferIdeLabel((legacy[1] || '').trim()),
      structured: false,
    }
  }

  return {
    raw,
    displayName: raw,
    ownerAttribution: null,
    ideLabel: inferIdeLabel(raw),
    structured: false,
  }
}

function normalizeIdeLabel(label: string): string | null {
  const n = (label || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!n) return null
  const known: Record<string, string> = {
    codex: 'Codex',
    antigravity: 'Antigravity',
    claude: 'Claude',
    cursor: 'Cursor',
    opencode: 'OpenCode',
    agent: 'Agent',
  }
  return (
    known[n] ||
    n
      .split('-')
      .filter(Boolean)
      .map((p) => p[0].toUpperCase() + p.slice(1))
      .join(' ')
  )
}

function inferIdeLabel(value: string): string | null {
  const n = (value || '').trim().toLowerCase()
  if (n.startsWith('codex')) return 'Codex'
  if (n.startsWith('antigravity')) return 'Antigravity'
  if (n.startsWith('claude')) return 'Claude'
  if (n.startsWith('cursor')) return 'Cursor'
  return null
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
