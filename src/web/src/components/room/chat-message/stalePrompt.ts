import type { RoomMessage, StalePromptTaskState } from '@/composables/useRoom'

export function stalePromptTaskIdFor(message: RoomMessage): string | null {
  if ((message.sender || '').toLowerCase() !== 'letagents') return null
  if (!/^\[status\]\s+Stale\b/i.test(message.text || '')) return null
  return /\b(task_\d+)\b/.exec(message.text || '')?.[1] || null
}

export function isCurrentStalePrompt(taskState: StalePromptTaskState | null, promptTimestamp: string): boolean {
  const taskUpdatedAtMs = Date.parse(taskState?.taskUpdatedAt || '')
  const promptTimestampMs = Date.parse(promptTimestamp)
  if (!taskState || !Number.isFinite(taskUpdatedAtMs) || !Number.isFinite(promptTimestampMs)) {
    return false
  }
  return taskUpdatedAtMs <= promptTimestampMs
}
