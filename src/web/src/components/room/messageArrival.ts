import { watch, type WatchStopHandle } from 'vue'

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

export function mergeMessageArrivalIds(
  currentIds: ReadonlySet<string>,
  appendedIds: readonly string[],
): ReadonlySet<string> {
  return new Set([...currentIds, ...appendedIds])
}

export interface MessageListGrowth {
  /** Older messages were loaded above the ones already shown. */
  prepended: boolean
  /** Messages added after the previous last message, excluding prepends. */
  appendedIds: string[]
  addedCount: number
}

/**
 * Calls `onGrowth` whenever the message list gets longer. Live messages are
 * pushed onto the same array (appendRoomMessage), so this watches the length
 * as well as the array, and diffs against the ids it last saw rather than the
 * watcher's old value, which is the same mutated array after a push.
 */
export function watchMessageListGrowth(
  messages: () => readonly { id: string }[],
  onGrowth: (growth: MessageListGrowth) => void,
): WatchStopHandle {
  let previousIds = messages().map((message) => message.id)
  return watch([messages, () => messages().length], () => {
    const oldIds = previousIds
    const newIds = messages().map((message) => message.id)
    previousIds = newIds
    if (newIds.length <= oldIds.length) return

    const oldFirstId = oldIds[0]
    const oldLastId = oldIds[oldIds.length - 1]
    const prepended = Boolean(
      oldFirstId && oldLastId && newIds[0] !== oldFirstId && newIds[newIds.length - 1] === oldLastId,
    )
    onGrowth({
      prepended,
      appendedIds: prepended ? [] : getAppendedMessageIds(oldIds, newIds),
      addedCount: newIds.length - oldIds.length,
    })
  })
}
