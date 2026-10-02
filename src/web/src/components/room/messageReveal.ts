export type MessageRevealAction =
  | 'scroll'
  | 'wait'
  | 'load_older'
  | 'too_far_back'
  | 'unavailable'

export interface MessageRevealDecisionInput {
  found: boolean
  historyReady: boolean
  hasOlder: boolean
  loading: boolean
  pagesRequested: number
  maxPages?: number
}

export const DEFAULT_MAX_REVEAL_PAGES = 20

/**
 * Pure decision function for message reveals in MessageList.
 *
 * Core invariants:
 * 1. If found in the loaded list, scroll immediately.
 * 2. If history is not yet ready or a page load is in flight, wait.
 * 3. Never report "unavailable" or "too_far_back" while a load is in flight.
 * 4. Only report "unavailable" when history is ready, no load is in flight,
 *    and no older pages remain.
 * 5. Report "too_far_back" only when history is ready, no load is in flight,
 *    older pages exist, but the max page bound has been reached.
 */
export function decideMessageRevealAction(
  input: MessageRevealDecisionInput,
): MessageRevealAction {
  if (input.found) {
    return 'scroll'
  }
  if (!input.historyReady || input.loading) {
    return 'wait'
  }
  const maxPages = input.maxPages ?? DEFAULT_MAX_REVEAL_PAGES
  if (input.hasOlder) {
    if (input.pagesRequested < maxPages) {
      return 'load_older'
    }
    return 'too_far_back'
  }
  return 'unavailable'
}
