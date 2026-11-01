import { computed, onScopeDispose, reactive, ref, watch, type Ref } from 'vue'
import { apiFetch } from '../room/api'
import { compareItems, createInboxApi, threadItems, type InboxItem, type InboxSection, type InboxSnapshot } from './api'
import type { KnowledgeRecord } from '../../../../../shared/room-knowledge.mjs'

export function useInbox(accountId: Ref<string | null>, api = createInboxApi(apiFetch)) {
  const snapshot = ref<InboxSnapshot | null>(null), loading = ref(false), error = ref(''), actionError = ref(''), outcome = ref('')
  const section = ref<InboxSection>('needs-you'), rooms = ref<string[]>([]), query = ref(''), selectedKey = ref('')
  const drafts = reactive<Record<string, string>>({}), answers = ref<Record<string, KnowledgeRecord>>({})
  const sending = ref(false), loadingOlder = ref(false), dismissals = ref<Record<string, string>>({})
  const lastRead = ref<Array<{ key: string; fingerprint: string; previous?: string }>>([])
  let request = 0, session = 0, alive = true, controller: AbortController | null = null
  const roomItems = computed(() => (snapshot.value?.items || []).map(item => {
    const record = answers.value[item.key]
    return record && item.record && record.version >= item.record.version ? { ...item, record, section: 'answered' as const, timestamp: record.response?.at || item.timestamp, category: record.response?.closed ? 'Closed' : item.category } : item
  }).filter(item => (!rooms.value.length || rooms.value.includes(item.roomId)) && (item.section !== 'updates' || dismissals.value[item.key] !== item.fingerprint)))
  const counts = computed(() => ({ 'needs-you': roomItems.value.filter(item => item.section === 'needs-you').length, updates: roomItems.value.filter(item => item.section === 'updates').length, answered: roomItems.value.filter(item => item.section === 'answered').length }))
  let previous: { scope: string; keys: string[] } = { scope: '', keys: [] }
  const items = computed(() => {
    const needle = query.value.trim().toLocaleLowerCase()
    const scope = JSON.stringify([accountId.value, section.value, rooms.value, needle])
    const next = roomItems.value.filter(item => item.section === section.value && (!needle || `${item.title} ${item.body} ${item.actor} ${item.roomName}`.toLocaleLowerCase().includes(needle))).sort(compareItems)
    if (previous.scope === scope) {
      const byKey = new Map(next.map(item => [item.key, item]))
      const ordered = previous.keys.flatMap(key => byKey.get(key) || [])
      const known = new Set(ordered.map(item => item.key))
      const floor = ordered.findIndex(item => item.key === selectedKey.value) + 1
      for (const item of next.filter(item => !known.has(item.key))) {
        const index = ordered.findIndex((other, index) => index >= floor && compareItems(item, other) < 0)
        ordered.splice(index < 0 ? ordered.length : index, 0, item)
      }
      previous = { scope, keys: ordered.map(item => item.key) }
      return ordered
    }
    previous = { scope, keys: next.map(item => item.key) }; return next
  })
  const selected = computed(() => items.value.find(item => item.key === selectedKey.value) || null)
  watch(items, (next, old) => {
    if (next.some(item => item.key === selectedKey.value)) return
    const index = old?.findIndex(item => item.key === selectedKey.value) ?? -1
    selectedKey.value = next[Math.max(0, Math.min(index, next.length - 1))]?.key || ''
  }, { immediate: true })
  watch(selectedKey, () => { actionError.value = '' })
  function selectItem(key: string) { selectedKey.value = key; outcome.value = '' }
  const failures = computed(() => snapshot.value?.failures.filter(failure => !rooms.value.length || rooms.value.includes(failure.roomId)) || [])
  const moreThreads = computed(() => (snapshot.value?.rooms || []).filter(room => snapshot.value?.threads[room.id]?.has_more && (!rooms.value.length || rooms.value.includes(room.id))))
  async function refresh() {
    if (!accountId.value || !alive) return
    controller?.abort(); controller = new AbortController()
    const run = ++request, signal = controller.signal
    loading.value = true; error.value = ''
    try { const data = await api.load(signal); if (alive && run === request) snapshot.value = data }
    catch (cause) { if (alive && run === request && !signal.aborted) error.value = cause instanceof Error ? cause.message : 'Could not load your inbox.' }
    finally { if (alive && run === request) loading.value = false }
  }
  function persist() {
    try { if (accountId.value) localStorage.setItem(`letagents-web:inbox-read:${accountId.value}`, JSON.stringify(dismissals.value)) } catch { /* Keep this session usable without storage. */ }
  }
  function markRead(list: InboxItem[]) {
    const next = { ...dismissals.value }
    lastRead.value = list.filter(item => item.section === 'updates' && next[item.key] !== item.fingerprint).map(item => {
      const previous = next[item.key]; next[item.key] = item.fingerprint
      return { key: item.key, fingerprint: item.fingerprint, previous }
    })
    dismissals.value = next; persist()
  }
  function undoRead() {
    const next = { ...dismissals.value }
    for (const change of lastRead.value) if (next[change.key] === change.fingerprint) {
      if (change.previous === undefined) delete next[change.key]; else next[change.key] = change.previous
    }
    dismissals.value = next; lastRead.value = []; persist()
  }
  async function answer(close = false) {
    const item = selected.value, response = item ? drafts[item.key] || '' : ''
    if (!accountId.value || !item?.record || sending.value || (!close && !response.trim())) return
    const current = session, displayed = items.value
    sending.value = true; actionError.value = ''
    try {
      const record = await api.answer(item, response, close)
      if (!alive || current !== session) return
      const keepFocus = selectedKey.value === item.key
      answers.value = { ...answers.value, [item.key]: record }; delete drafts[item.key]
      if (keepFocus) {
        const remaining = new Set(items.value.map(other => other.key))
        const index = displayed.findIndex(other => other.key === item.key)
        const next = displayed.slice(index + 1).find(other => remaining.has(other.key) && other.key !== item.key)
          ?? displayed.slice(0, index).reverse().find(other => remaining.has(other.key) && other.key !== item.key)
          ?? items.value.find(other => other.key !== item.key)
        if (next) selectedKey.value = next.key
        else { section.value = 'answered'; selectedKey.value = item.key }
      }
      outcome.value = close ? 'Request closed.' : 'Response sent.'
      void refresh()
      // The page restores focus only when this request was still being read.
      return keepFocus ? selectedKey.value : undefined
    } catch (cause) { if (alive && current === session) actionError.value = cause instanceof Error ? cause.message : 'Could not save your response.' }
    finally { if (alive && current === session) sending.value = false }
  }
  async function loadOlder(roomId: string) {
    const room = snapshot.value?.rooms.find(room => room.id === roomId)
    const old = snapshot.value?.threads[roomId], before = old?.threads.at(-1)?.summary.latest_reply?.id
    if (!room || !before || !old?.has_more || loadingOlder.value) return
    const current = session, read = request
    loadingOlder.value = true; actionError.value = ''
    try {
      const page = await api.threads(roomId, before, controller?.signal)
      if (!alive || current !== session || read !== request || !snapshot.value) return
      const threads = [...new Map([...old.threads, ...page.threads].map(thread => [thread.root.id, thread])).values()]
      snapshot.value = { ...snapshot.value, threads: { ...snapshot.value.threads, [roomId]: { ...page, threads } },
        items: [...new Map([...snapshot.value.items, ...threadItems(room, page)].map(item => [item.key, item])).values()] }
    } catch (cause) { if (alive && current === session && read === request) actionError.value = cause instanceof Error ? cause.message : 'Could not load older replies.' }
    finally { if (alive && current === session) loadingOlder.value = false }
  }
  watch(accountId, () => {
    session++; request++; controller?.abort(); snapshot.value = null; error.value = ''; actionError.value = ''; outcome.value = ''
    rooms.value = []; query.value = ''; selectedKey.value = ''; section.value = 'needs-you'; dismissals.value = {}; lastRead.value = []; answers.value = {}; sending.value = false; loading.value = false; loadingOlder.value = false
    for (const key of Object.keys(drafts)) delete drafts[key]
    if (!accountId.value) return
    try {
      const saved = JSON.parse(localStorage.getItem(`letagents-web:inbox-read:${accountId.value}`) || '{}')
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) dismissals.value = Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    } catch { /* Browser storage is optional. */ }
    void refresh()
  }, { immediate: true })
  onScopeDispose(() => { alive = false; session++; request++; controller?.abort() })
  return { snapshot, loading, error, actionError, outcome, section, rooms, query, selectedKey, drafts, sending, loadingOlder, lastRead,
    counts, items, selected, failures, moreThreads, selectItem, refresh, markRead, undoRead, answer, loadOlder }
}
