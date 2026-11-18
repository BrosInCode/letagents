/** A `[status] …` line from LetAgents itself that is routine, not a problem. */
export function isAmbientSystemMessage(sender: string, text: string): boolean {
  const normalizedSender = String(sender || '').trim().toLowerCase()
  const normalizedText = String(text || '')
  return ['letagents', 'system'].includes(normalizedSender)
    && /^\[status\]\s*/i.test(normalizedText)
    && !/\b(stale|blocked|failed|error|cannot|can't|cancelled)\b/i.test(normalizedText)
}

export function stripStatusPrefix(text: string): string {
  return String(text || '').replace(/^\[status\]\s*/i, '').trim()
}

/**
 * Ids that arrived after the previous last message. A prepend of older
 * messages, or a list that no longer holds the previous last id, gives none.
 */
export function getAppendedMessageIds(
  previousIds: readonly string[],
  nextIds: readonly string[],
): string[] {
  if (previousIds.length === 0 || nextIds.length <= previousIds.length) return []

  const previousLastId = previousIds[previousIds.length - 1]
  const previousLastIndex = nextIds.indexOf(previousLastId)
  if (previousLastIndex < 0) return []

  const previousIdSet = new Set(previousIds)
  return nextIds
    .slice(previousLastIndex + 1)
    .filter((id) => !previousIdSet.has(id))
}
