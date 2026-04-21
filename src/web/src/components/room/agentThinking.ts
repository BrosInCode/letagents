import type { RoomAgentPresence, RoomMessage } from '@/composables/useRoom'

export type AgentThinkingPhase = RoomAgentPresence['status'] | 'note'

export interface AgentThinkingField {
  key: 'goal' | 'hypothesis' | 'evidence' | 'next' | 'blocker' | 'confidence'
  label: string
  value: string
}

export interface AgentThinkingCardData {
  phase: AgentThinkingPhase
  phaseLabel: string
  summary: string
  details: string[]
  fields: AgentThinkingField[]
  isStatus: boolean
}

export interface AgentThinkingTimelineEntry extends AgentThinkingCardData {
  id: string
  timestamp: string
}

const STATUS_PREFIX_RE = /^\[status\]\s*/i
const STRUCTURED_FIELD_RE = /^(goal|hypothesis|evidence|next|blocker|confidence):\s*(.+)$/i
const IDLE_STATUS_RE = /\b(idle|available|online|polling|monitoring|watch(?:ing)?|ready|standby)\b/i
const IDLE_WAITING_STATUS_RE = /\b(?:awaiting|waiting)\s+(?:for\s+)?(?:tasks?|work|instructions?|direction|assignment|assignments|next(?:\s+task)?|queue)\b/i
const REVIEWING_STATUS_RE = /\b(review|reviewing|approve|approval|approving)\b/i
const BLOCKED_STATUS_RE = /\b(blocked|waiting|stuck|error|failing|failed|cannot|can't|missing)\b/i
const NEXT_ACTION_RE = /^(?:next|then|doing it now|i(?:'|’)ll|i will|going to|plan to|will)\b/i
const TRIVIAL_AGENT_NOTE_RE = /^(?:hi|hello|here|thanks|thank you|ok(?:ay)?|sure|seen|noted)\b/i

const FIELD_LABELS: Record<AgentThinkingField['key'], string> = {
  goal: 'Goal',
  hypothesis: 'Hypothesis',
  evidence: 'Evidence',
  next: 'Next',
  blocker: 'Blocker',
  confidence: 'Confidence',
}

const FIELD_ORDER: AgentThinkingField['key'][] = [
  'goal',
  'hypothesis',
  'evidence',
  'next',
  'blocker',
  'confidence',
]

interface BuildAgentThinkingEntryOptions {
  status?: RoomAgentPresence['status'] | null
  allowPlainAgentNotes?: boolean
}

function cleanThoughtLine(line: string): string {
  return String(line || '')
    .trim()
    .replace(/^[*-]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function splitThoughtLines(text: string): string[] {
  return String(text || '')
    .split(/\n+/)
    .flatMap((line) => {
      const cleaned = cleanThoughtLine(line)
      if (!cleaned) return []

      const sentences = cleaned
        .split(/(?<=[.!?])\s+(?=[A-Z0-9`])/)
        .map((entry) => entry.trim())
        .filter(Boolean)

      return sentences.length > 1 ? sentences : [cleaned]
    })
}

function classifyThinkingPhase(input: {
  status?: RoomAgentPresence['status'] | null
  text: string
  hasBlockerField: boolean
  isStatus: boolean
  isPlainNote: boolean
}): AgentThinkingPhase {
  if (input.status) return input.status
  if (input.hasBlockerField || BLOCKED_STATUS_RE.test(input.text)) return 'blocked'
  if (IDLE_WAITING_STATUS_RE.test(input.text) || IDLE_STATUS_RE.test(input.text)) return 'idle'
  if (REVIEWING_STATUS_RE.test(input.text)) return 'reviewing'
  if (input.isStatus) return 'working'
  return input.isPlainNote ? 'note' : 'working'
}

function getPhaseLabel(phase: AgentThinkingPhase): string {
  if (phase === 'idle') return 'Idle'
  if (phase === 'working') return 'Working'
  if (phase === 'reviewing') return 'Reviewing'
  if (phase === 'blocked') return 'Blocked'
  return 'Reasoning note'
}

function dedupeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const output: string[] = []
  for (const value of values) {
    const normalized = cleanThoughtLine(value)
    const key = normalized.toLowerCase()
    if (!normalized || seen.has(key)) continue
    seen.add(key)
    output.push(normalized)
  }
  return output
}

function sortFields(fields: readonly AgentThinkingField[]): AgentThinkingField[] {
  return [...fields].sort(
    (left, right) => FIELD_ORDER.indexOf(left.key) - FIELD_ORDER.indexOf(right.key)
  )
}

export function extractStatusText(text: string): string {
  return text.replace(STATUS_PREFIX_RE, '').trim()
}

export function buildAgentThinkingEntry(
  message: Pick<RoomMessage, 'id' | 'text' | 'timestamp' | 'source'>,
  options: BuildAgentThinkingEntryOptions = {}
): AgentThinkingTimelineEntry | null {
  const rawText = String(message.text || '').trim()
  if (!rawText || String(message.source || '').toLowerCase() !== 'agent') {
    return null
  }

  const isStatus = STATUS_PREFIX_RE.test(rawText)
  const normalizedText = isStatus ? extractStatusText(rawText) : rawText
  if (!normalizedText) {
    return null
  }

  const lines = splitThoughtLines(normalizedText)
  const fields: AgentThinkingField[] = []
  const plainLines: string[] = []

  for (const line of lines) {
    const match = line.match(STRUCTURED_FIELD_RE)
    if (match) {
      const key = match[1].toLowerCase() as AgentThinkingField['key']
      const value = cleanThoughtLine(match[2])
      if (value) {
        fields.push({ key, label: FIELD_LABELS[key], value })
      }
      continue
    }
    plainLines.push(line)
  }

  const allowPlainAgentNotes = Boolean(options.allowPlainAgentNotes)
  const isPlainAgentNote = !isStatus && fields.length === 0
  if (isPlainAgentNote && !allowPlainAgentNotes) {
    return null
  }

  const fallbackSummary = cleanThoughtLine(plainLines[0] || fields[0]?.value || normalizedText)
  if (!fallbackSummary) {
    return null
  }

  if (
    isPlainAgentNote
    && (TRIVIAL_AGENT_NOTE_RE.test(fallbackSummary) || fallbackSummary.length < 18)
  ) {
    return null
  }

  const autoFields = [...fields]
  const remainingPlainLines = plainLines.slice(1)

  const nextCandidate = dedupeStrings([
    ...remainingPlainLines.filter((line) => NEXT_ACTION_RE.test(line)),
    ...plainLines.filter((line) => NEXT_ACTION_RE.test(line) && line !== fallbackSummary),
  ])[0]
  if (nextCandidate && !autoFields.some((field) => field.key === 'next')) {
    autoFields.push({ key: 'next', label: FIELD_LABELS.next, value: nextCandidate })
  }

  const blockerCandidate = dedupeStrings(plainLines.filter((line) => BLOCKED_STATUS_RE.test(line)))[0]
  if (blockerCandidate && !autoFields.some((field) => field.key === 'blocker')) {
    autoFields.push({ key: 'blocker', label: FIELD_LABELS.blocker, value: blockerCandidate })
  }

  const phase = classifyThinkingPhase({
    status: options.status,
    text: normalizedText,
    hasBlockerField: autoFields.some((field) => field.key === 'blocker'),
    isStatus,
    isPlainNote: isPlainAgentNote,
  })

  const details = dedupeStrings(
    remainingPlainLines.filter((line) =>
      line !== fallbackSummary
      && !autoFields.some((field) => field.value.toLowerCase() === line.toLowerCase())
    )
  ).slice(0, 3)

  return {
    id: message.id,
    timestamp: message.timestamp,
    phase,
    phaseLabel: getPhaseLabel(phase),
    summary: fallbackSummary,
    details,
    fields: sortFields(autoFields).slice(0, 4),
    isStatus,
  }
}

export function buildAgentThinkingSnapshot(input: {
  messages: readonly Pick<RoomMessage, 'id' | 'text' | 'timestamp' | 'source'>[]
  status?: RoomAgentPresence['status'] | null
  statusText?: string | null
}): AgentThinkingCardData | null {
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const next = buildAgentThinkingEntry(input.messages[index]!, {
      status: input.status,
      allowPlainAgentNotes: true,
    })
    if (next) {
      return next
    }
  }

  const fallbackStatusText = cleanThoughtLine(input.statusText || '')
  if (!fallbackStatusText) {
    return null
  }

  return buildAgentThinkingEntry(
    {
      id: 'status-fallback',
      text: `[status] ${fallbackStatusText}`,
      timestamp: '',
      source: 'agent',
    },
    {
      status: input.status,
      allowPlainAgentNotes: true,
    }
  )
}

export function buildAgentThinkingTimeline(
  messages: readonly Pick<RoomMessage, 'id' | 'text' | 'timestamp' | 'source'>[]
): AgentThinkingTimelineEntry[] {
  return messages
    .map((message) => buildAgentThinkingEntry(message, { allowPlainAgentNotes: true }))
    .filter((entry): entry is AgentThinkingTimelineEntry => Boolean(entry))
    .slice(-5)
    .reverse()
}
