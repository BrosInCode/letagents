/**
 * Agent labels ("RiverFox | Ada's agent | Codex") as both apps read them. The
 * parsing is the server's own (src/shared/agent-identity), so the web, the
 * desktop and the API cannot drift apart; this file only maps the result to
 * the camelCase shape the apps use.
 */
import { formatOwnerAttribution, parseAgentActorLabel } from '../../src/shared/agent-identity'

export interface AgentLabel {
  raw: string
  displayName: string
  ownerAttribution: string | null
  ideLabel: string | null
  /** True for the three-part "name | owner's agent | IDE" form. */
  structured: boolean
}

export function parseAgentLabel(value: string | null | undefined): AgentLabel {
  const parsed = parseAgentActorLabel(value)
  if (!parsed) return { raw: '', displayName: '', ownerAttribution: null, ideLabel: null, structured: false }
  return {
    raw: parsed.raw,
    displayName: parsed.display_name,
    ownerAttribution: parsed.owner_attribution,
    ideLabel: parsed.ide_label,
    structured: parsed.structured,
  }
}

/** "Ada" -> "Ada's agent"; a label already in that form is kept. */
export function ownerAttributionFromOwnerLabel(ownerLabel: string | null | undefined): string | null {
  const owner = String(ownerLabel || '').trim()
  if (!owner) return null
  return /['’]s?\s+agent$/i.test(owner) ? owner : formatOwnerAttribution(owner)
}
