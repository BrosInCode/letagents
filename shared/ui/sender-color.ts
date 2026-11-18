import { parseAgentActorLabel } from '../../src/shared/agent-identity'

/**
 * One color per owner: a person and every agent they own share it, in the
 * web app and the desktop app alike. LetAgents' own lines are gray and
 * GitHub events have one fixed color.
 */
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
] as const

export const SYSTEM_SENDER_COLOR = 'var(--sender-default, #71717a)'
export const GITHUB_SENDER_COLOR = '#a78bfa'

const colorCache = new Map<string, string>()

function hashString(value: string): number {
  let hash = 5381
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) >>> 0
  }
  return hash
}

/** "EmmyMay's agent" -> "emmymay"; a person's own name is its own key. */
export function senderOwnerKey(sender: string): string | null {
  const parsed = parseAgentActorLabel(sender)
  if (!parsed) return null
  const attribution = parsed.owner_attribution
  if (attribution) {
    const owner = attribution.match(/^(.+?)['’]s?\s+agent$/i)?.[1]?.trim()
    return (owner || attribution).toLowerCase()
  }
  return parsed.raw.toLowerCase()
}

export function getSenderColor(sender: string, source: string | null): string {
  if (source === 'github') return GITHUB_SENDER_COLOR
  const normalized = String(sender || '').trim().toLowerCase()
  if (normalized === 'letagents' || normalized === 'system') return SYSTEM_SENDER_COLOR
  const ownerKey = senderOwnerKey(sender)
  if (!ownerKey) return SYSTEM_SENDER_COLOR
  const cached = colorCache.get(ownerKey)
  if (cached) return cached
  const color = OWNER_COLORS[hashString(ownerKey) % OWNER_COLORS.length]
  colorCache.set(ownerKey, color)
  return color
}
