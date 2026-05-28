import { computed, nextTick, ref, watch, type ComputedRef, type Ref } from 'vue'
import type { MentionCandidate } from '../reachability'

export function useComposerMentions(input: {
  text: Ref<string>
  textareaEl: Ref<HTMLTextAreaElement | null>
  mentionCandidates: ComputedRef<MentionCandidate[]>
  refreshReachability: ComputedRef<(() => Promise<unknown> | unknown) | undefined>
}) {
  const mentionQuery = ref('')
  const mentionStart = ref(-1)
  const mentionEnd = ref(-1)
  const mentionActiveIndex = ref(0)

  let mentionReachabilityRefreshAt = 0
  let mentionReachabilityRefreshInFlight = false

  const filteredMentionCandidates = computed(() => {
    const query = mentionQuery.value.trim().toLowerCase()
    const filtered = input.mentionCandidates.value
      .filter((candidate) => !query || candidate.search.includes(query))

    // Guarantee humans (priority >= 2) are never pushed off by a flood of agents.
    const agents = filtered.filter((c) => c.priority < 2)
    const humans = filtered.filter((c) => c.priority >= 2)
    const maxAgents = Math.max(0, 8 - humans.length)
    return [...agents.slice(0, maxAgents), ...humans].slice(0, 8)
  })

  const mentionMenuOpen = computed(() =>
    mentionStart.value >= 0 && filteredMentionCandidates.value.length > 0
  )

  function resetMentionContext() {
    mentionQuery.value = ''
    mentionStart.value = -1
    mentionEnd.value = -1
    mentionActiveIndex.value = 0
  }

  function requestMentionReachabilityRefresh() {
    const refreshReachability = input.refreshReachability.value
    if (!refreshReachability || mentionReachabilityRefreshInFlight) return

    const now = Date.now()
    if (now - mentionReachabilityRefreshAt < 2000) return

    mentionReachabilityRefreshAt = now
    mentionReachabilityRefreshInFlight = true
    Promise.resolve(refreshReachability())
      .catch(() => undefined)
      .finally(() => {
        mentionReachabilityRefreshInFlight = false
      })
  }

  function syncMentionContext() {
    const textarea = input.textareaEl.value
    if (!textarea) {
      resetMentionContext()
      return
    }

    const cursor = textarea.selectionStart ?? input.text.value.length
    const beforeCursor = input.text.value.slice(0, cursor)
    const match = beforeCursor.match(/(^|[\s(])@([A-Za-z0-9._-]*)$/)
    if (!match) {
      resetMentionContext()
      return
    }

    const wasClosed = mentionStart.value < 0
    mentionQuery.value = (match[2] || '').toLowerCase()
    mentionStart.value = cursor - mentionQuery.value.length - 1
    mentionEnd.value = cursor
    mentionActiveIndex.value = 0
    if (wasClosed) {
      requestMentionReachabilityRefresh()
    }
  }

  function moveMentionSelection(direction: number) {
    if (!filteredMentionCandidates.value.length) return
    const size = filteredMentionCandidates.value.length
    mentionActiveIndex.value = (mentionActiveIndex.value + direction + size) % size
  }

  function selectMention(candidate: MentionCandidate) {
    if (mentionStart.value < 0 || mentionEnd.value < 0) return

    const nextChar = input.text.value.slice(mentionEnd.value, mentionEnd.value + 1)
    const suffix = nextChar && /\s/.test(nextChar) ? '' : ' '
    const insertion = `@${candidate.mention}${suffix}`
    const newCursor = mentionStart.value + insertion.length

    input.text.value = `${input.text.value.slice(0, mentionStart.value)}${insertion}${input.text.value.slice(mentionEnd.value)}`
    resetMentionContext()

    nextTick(() => {
      input.textareaEl.value?.focus()
      input.textareaEl.value?.setSelectionRange(newCursor, newCursor)
    })
  }

  watch(filteredMentionCandidates, (candidates) => {
    if (mentionActiveIndex.value >= candidates.length) {
      mentionActiveIndex.value = 0
    }
  })

  return {
    filteredMentionCandidates,
    mentionMenuOpen,
    mentionActiveIndex,
    resetMentionContext,
    syncMentionContext,
    moveMentionSelection,
    selectMention,
  }
}
