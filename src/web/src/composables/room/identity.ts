import type {
  MessageReplyReference,
  RoomAgentPromptKind,
  RoomMessage,
} from './types'

const OWNER_COLORS = [
  '#a855f7',
  '#3b82f6',
  '#22c55e',
  '#f59e0b',
  '#ef4444',
  '#06b6d4',
  '#ec4899',
  '#14b8a6',
  '#f97316',
  '#8b5cf6',
  '#10b981',
  '#6366f1',
]
const colorCache = new Map<string, string>()

function hashString(str: string): number {
  let hash = 5381
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0
  }
  return hash
}

export function getSenderColor(sender: string, source: string | null): string {
  const owner = getOwnerFromSender(sender, source)
  if (!owner) return 'var(--sender-default, #71717a)'
  const ownerKey = owner.toLowerCase()
  if (colorCache.has(ownerKey)) return colorCache.get(ownerKey)!
  const color = OWNER_COLORS[hashString(ownerKey) % OWNER_COLORS.length]
  colorCache.set(ownerKey, color)
  return color
}

function getOwnerFromSender(
  sender: string,
  source: string | null,
): string | null {
  const parsed = parseAgentIdentity(sender)
  if (parsed.structured && parsed.ownerAttribution) {
    // Extract owner name from "Owner's agent"
    const match = parsed.ownerAttribution.match(/^(.+?)(?:'s?\s+agent)$/i)
    return match ? match[1] : parsed.ownerAttribution
  }
  if (isHumanSender(sender, source)) return sender || null
  return parsed.displayName || sender || null
}

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
