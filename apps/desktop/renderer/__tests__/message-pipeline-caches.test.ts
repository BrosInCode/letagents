import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { computed, createRenderer, createSSRApp, defineComponent, effectScope, h, nextTick, ref, shallowReactive, shallowRef } from 'vue'
import { createServer } from 'vite'
import type { DesktopRoomAgentWork, DesktopRoomMessage } from '../../electron/ipc-types'
import {
  compareText, formatCompactNumber, formatDate, formatDecimalNumber, formatterBuildCount,
} from '../src/domain/formatters'
import {
  compareRoomMessages, createMessageIdentityVersion, mergeRoomMessages, roomMessageSortKeyBuilds,
} from '../src/components/desktop/content/room-shell/messages'
import { buildMessageTimelineEntries, timelineFormatBuilds } from '../src/components/desktop/content/room-chat/timeline'
import {
  highlightPatternBuilds, highlightRenderedMessage, linkRenderedMessageReferences, mayContainMessageReference,
} from '../src/components/desktop/content/desktop-chat-message/message-rendering'
import { syncIdSet, useStableIdSet } from '../src/composables/useStableIdSet'
import { createThreadIndicatorMemo } from '../src/components/desktop/content/room-chat/thread-utils'

const ROOM_SIZE = 3000

function message(index: number, overrides: Partial<DesktopRoomMessage> = {}): DesktopRoomMessage {
  const id = `msg_${index}`
  return {
    id, sender: index % 3 ? 'EmmyMay' : 'Agent', text: `message ${index} see msg_${Math.max(1, index - 3)}`,
    attachments: [], agentPromptKind: null, source: 'browser',
    timestamp: new Date(Date.UTC(2026, 5, 1 + Math.floor(index / 200), 8, 0, index % 60 * 3)).toISOString(),
    actorLabel: null, agentIdentity: null, threadRootId: id, threadReplyToId: null, thread: null, replyTo: null,
    ...overrides,
  } as DesktopRoomMessage
}
const room = (size = ROOM_SIZE) => Array.from({ length: size }, (_, index) => message(index + 1))

describe('shared formatters', () => {
  const samples = ['2026-06-17T00:00:00.000Z', '2026-12-31T23:59:59.000Z', '2024-02-29T12:30:00.000Z', new Date().toISOString()]

  it('print exactly what the per-call toLocale and Intl constructors print', () => {
    for (const value of samples) {
      const date = new Date(value)
      assert.equal(formatDate('clockTime', value), date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
      assert.equal(formatDate('clockTime', date), date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }))
      assert.equal(formatDate('dateDivider', value), date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }))
      assert.equal(formatDate('monthDayTime2', value), date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))
      assert.equal(formatDate('monthDayTime', value), date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))
      assert.equal(formatDate('monthDayTime', value), new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date))
      assert.equal(formatDate('hourMinute', value), date.toLocaleString(undefined, { hour: 'numeric', minute: '2-digit' }))
      assert.equal(formatDate('weekdayHourMinute', value), date.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }))
    }
    for (const value of [0, 999, 1234567, 12_345_678, 0.5, 1_000_000_000]) {
      assert.equal(formatCompactNumber(value), new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value))
      assert.equal(formatDecimalNumber(value), new Intl.NumberFormat().format(value))
    }
  })

  it('return what toLocale*String returns for an invalid date instead of throwing', () => {
    assert.equal(formatDate('clockTime', 'not a date'), new Date('not a date').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
    assert.equal(formatDate('dateDivider', 'nope'), new Date('nope').toLocaleDateString())
  })

  it('compareText orders like localeCompare', () => {
    const words = ['b', 'a', 'B', 'A', 'é', 'e', 'z', 'Z', 'msg_10', 'msg_2', '', ' x', 'ñ', 'n']
    for (const left of words) for (const right of words) {
      assert.equal(Math.sign(compareText(left, right)), Math.sign(left.localeCompare(right)), `${left} vs ${right}`)
    }
    assert.deepEqual([...words].sort(compareText), [...words].sort((a, b) => a.localeCompare(b)))
  })

  it('build one Intl object per preset however many times they are used', () => {
    const before = { ...formatterBuildCount }
    for (let index = 0; index < 5000; index += 1) {
      formatDate('clockTime', samples[index % samples.length]!)
      formatDate('dateDivider', samples[index % samples.length]!)
      formatCompactNumber(index)
      formatDecimalNumber(index)
      compareText('a', String(index))
    }
    // Presets used earlier in this file are already built; later calls add none.
    assert.equal(formatterBuildCount.dateTime - before.dateTime, 0)
    assert.equal(formatterBuildCount.number - before.number, 0)
    assert.equal(formatterBuildCount.collator - before.collator, 0)
    assert.ok(formatterBuildCount.dateTime <= 6 && formatterBuildCount.number <= 2 && formatterBuildCount.collator <= 1)
  })
})

describe('room message sort keys', () => {
  it('parse each message once across repeated merges of a large room', () => {
    const messages = room()
    const shuffled = [...messages].reverse()
    const buildsBefore = roomMessageSortKeyBuilds.count
    let comparisons = 0
    const merged = mergeRoomMessages([], shuffled)
    for (let pass = 0; pass < 3; pass += 1) mergeRoomMessages(merged, [])
    ;[...messages, ...messages].sort((left, right) => { comparisons += 1; return compareRoomMessages(left, right) })
    const builds = roomMessageSortKeyBuilds.count - buildsBefore
    // Before this change every comparison ran two regexes and two Date.parse calls.
    console.log(`sort keys: ${builds} key builds, ${comparisons} comparisons in the last sort alone (was 2 regex + 2 parse per comparison)`)
    assert.equal(builds, messages.length)
    assert.deepEqual(merged.map(item => item.id), messages.map(item => item.id))
  })

  it('rebuild a key when the message id or timestamp is edited in place', () => {
    const first = message(1), second = message(2)
    assert.ok(compareRoomMessages(first, second) < 0)
    const builds = roomMessageSortKeyBuilds.count
    compareRoomMessages(first, second)
    assert.equal(roomMessageSortKeyBuilds.count, builds)
    first.id = 'msg_9'
    assert.ok(compareRoomMessages(first, second) > 0)
    assert.equal(roomMessageSortKeyBuilds.count, builds + 1)
    second.timestamp = '2001-01-01T00:00:00.000Z'
    second.id = 'local-b'
    first.id = 'local-a'
    assert.ok(compareRoomMessages(first, second) > 0)
  })

  it('keep the fallback order for ids without numbers', () => {
    const a = message(1, { id: 'pending:a', timestamp: '2026-01-01T00:00:00Z' })
    const b = message(2, { id: 'pending:b', timestamp: '2026-01-01T00:00:00Z' })
    const numbered = message(3, { timestamp: '2026-01-01T00:00:00Z' })
    assert.deepEqual([b, numbered, a].sort(compareRoomMessages).map(item => item.id), ['msg_3', 'pending:a', 'pending:b'])
  })
})

describe('message identity version', () => {
  it('moves only when ids or client ids change', () => {
    const version = createMessageIdentityVersion()
    const messages = room(500)
    const first = version(messages)
    assert.equal(version([...messages]), first, 'a new array with the same ids is not a change')
    assert.equal(version(messages.map(item => ({ ...item }))), first, 'new objects with the same ids are not a change')
    const appended = [...messages, message(501)]
    const second = version(appended)
    assert.notEqual(second, first)
    const reconciled = appended.map(item => item.id === 'msg_501' ? { ...item, clientMessageId: 'client-1' } : item)
    assert.notEqual(version(reconciled), second)
    const removed = version(reconciled.slice(1))
    assert.notEqual(removed, second)
  })
})

describe('timeline entries', () => {
  // The previous implementation, kept as the reference for exact output.
  function referenceEntries(messages: readonly DesktopRoomMessage[]) {
    const dayKey = (timestamp: string) => {
      const date = new Date(timestamp)
      if (Number.isNaN(date.getTime())) return 'unknown'
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    }
    const label = (timestamp: string) => {
      const date = new Date(timestamp)
      if (Number.isNaN(date.getTime())) return 'Unknown date'
      return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
    }
    return [...messages].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)).flatMap((item, index, all) => {
      const previous = all[index - 1]
      const out: unknown[] = []
      if (!previous || dayKey(previous.timestamp) !== dayKey(item.timestamp)) {
        out.push({ type: 'date', id: `date:${dayKey(item.timestamp)}:${item.id}`, label: label(item.timestamp), dateTime: dayKey(item.timestamp) })
      }
      return out
    })
  }

  it('produces the same day dividers as the per-message formatting did', () => {
    const messages = [...room(900), message(901, { timestamp: 'garbage' }), message(902, { timestamp: 'also garbage' })]
    const dividers = buildMessageTimelineEntries(messages).filter(entry => entry.type === 'date')
    assert.deepEqual(dividers, referenceEntries(messages))
  })

  it('formats each timestamp and each day once, then reuses them on the next build', () => {
    const messages = room()
    buildMessageTimelineEntries(messages)
    const beforeDay = timelineFormatBuilds.dayKeys, beforeLabel = timelineFormatBuilds.dividerLabels
    for (let append = 0; append < 5; append += 1) buildMessageTimelineEntries([...messages, message(ROOM_SIZE + 1 + append)])
    assert.equal(timelineFormatBuilds.dayKeys - beforeDay, 5, 'only the five new timestamps are parsed')
    assert.equal(timelineFormatBuilds.dividerLabels - beforeLabel, 0, 'no day label is formatted again')
  })

  it('keeps order, compact grouping and work placement for unsorted input and unparsable times', () => {
    const base = Date.parse('2026-06-01T08:00:00Z')
    const at = (seconds: number) => new Date(base + seconds * 1000).toISOString()
    const messages = [
      message(3, { timestamp: at(30), sender: 'A' }), message(1, { timestamp: at(0), sender: 'A' }), message(2, { timestamp: at(10), sender: 'A' }),
      message(4, { timestamp: at(900), sender: 'A' }), message(5, { timestamp: 'broken', sender: 'B' }),
    ]
    const changes = { state: 'ready', files: [{ path: 'a.ts' }], hidden_files: 0, additions: 1, deletions: 0, patch: '', patch_truncated: false, captured_at: at(5) }
    const work = [{ attemptId: 'att_1', sourceMessageId: 'msg_2', agentKey: 'a', summary: { contribution: { changes } } }] as unknown as DesktopRoomAgentWork[]
    const entries = buildMessageTimelineEntries(messages, work)
    const sequence = entries.filter(entry => !(entry.type === 'date')).map(entry =>
      entry.type === 'message' ? `${entry.id}:${entry.compactWithPrevious}` : entry.id).filter(id => !id.startsWith('msg_5'))
    // The result was captured before its cause by the host clock, so it sits after msg_2.
    assert.deepEqual(sequence, ['msg_1:false', 'msg_2:true', 'contribution:att_1', 'msg_3:false', 'msg_4:false'])
    assert.equal(entries.filter(entry => entry.type === 'message').length, 5)
  })

  it('timing: a 5,000 message room builds quickly on repeat builds', () => {
    const messages = room(5000)
    buildMessageTimelineEntries(messages)
    const start = performance.now()
    for (let index = 0; index < 20; index += 1) buildMessageTimelineEntries(messages)
    console.log(`timeline build, 5000 messages: ${((performance.now() - start) / 20).toFixed(2)} ms per build`)
  })

  it('rebuilds cached day keys when the time zone changes', () => {
    const previousZone = process.env.TZ
    const messages = [message(1, { timestamp: '2026-06-01T23:30:00.000Z' }), message(2, { timestamp: '2026-06-02T00:30:00.000Z' })]
    try {
      process.env.TZ = 'UTC'
      assert.equal(buildMessageTimelineEntries(messages).filter(entry => entry.type === 'date').length, 2)
      process.env.TZ = 'Pacific/Auckland'
      const dates = buildMessageTimelineEntries(messages).filter(entry => entry.type === 'date')
      assert.equal(dates.length, 1, 'both messages fall on 2 June in Auckland')
      assert.equal(dates[0]!.type === 'date' && dates[0]!.dateTime, '2026-06-02')
    } finally {
      if (previousZone === undefined) delete process.env.TZ; else process.env.TZ = previousZone
    }
  })
})

describe('message search highlight', () => {
  // The previous implementation, kept as the reference for exact output.
  function referenceHighlight(html: string, query: string): string {
    const normalized = query.trim()
    if (!normalized) return html
    const stack: string[] = []
    return html.split(/(<[^>]+>)/g).map((chunk) => {
      if (!chunk) return ''
      if (chunk.startsWith('<') && chunk.endsWith('>')) {
        const tag = /^<\/?\s*([A-Za-z0-9-]+)/.exec(chunk)
        if (tag && tag[1]!.toLowerCase() === 'code') {
          if (/^<\//.test(chunk)) { if (stack.length) stack.pop() } else if (!/\/\s*>$/.test(chunk)) stack.push('code')
        }
        return chunk
      }
      if (stack.length) return chunk
      const units: Array<{ decoded: string; encoded: string }> = []
      for (let index = 0; index < chunk.length;) {
        const entity = /^&(amp|lt|gt|quot);/i.exec(chunk.slice(index))
        if (entity) {
          const name = entity[1]!.toLowerCase()
          units.push({ decoded: name === 'amp' ? '&' : name === 'lt' ? '<' : name === 'gt' ? '>' : '"', encoded: entity[0] })
          index += entity[0].length
          continue
        }
        units.push({ decoded: chunk[index]!, encoded: chunk[index]! })
        index += 1
      }
      const decoded = units.map(unit => unit.decoded).join('')
      const pattern = new RegExp(normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
      const starts = new Set<number>(), ends = new Set<number>()
      for (const match of decoded.matchAll(pattern)) {
        if (match.index === undefined || !match[0]) continue
        starts.add(match.index); ends.add(match.index + match[0].length)
      }
      if (!starts.size) return chunk
      return units.map((unit, index) => [starts.has(index) ? '<mark class="message-search-hit">' : '', unit.encoded, ends.has(index + 1) ? '</mark>' : ''].join('')).join('')
    }).join('')
  }

  const fixtures = [
    '<p>Hello World, hello again</p>', '<p>a &amp; b &lt;tag&gt; &quot;q&quot; &AMP; done</p>', '<p>use <code>hello</code> and hello</p>',
    '<p>aaaa</p>', '<p><a href="https://hello.example">hello</a> link</p>', '<p>plain text only</p>', '', '<p>ünïcode HELLO İstanbul</p>',
    '<p>x.y (z) [w] * + ? ^ $ | \\ end</p>', '<pre><code>hello\nhello</code></pre><p>hello</p>',
  ]
  const queries = ['hello', 'HELLO', 'a', 'aa', '&', '<tag>', '"q"', 'amp;', 'x.y', '(z)', '[w]', '*', '$ |', '\\', 'İstanbul', '  hello  ', 'zzz', '']

  it('marks exactly what the previous implementation marked', () => {
    for (const html of fixtures) for (const query of queries) {
      assert.equal(highlightRenderedMessage(html, query), referenceHighlight(html, query), JSON.stringify([html, query]))
    }
  })

  it('compiles one pattern for a query across a whole room, and a new one when the query changes', () => {
    const htmls = room().map(item => `<p>${item.text}</p>`)
    highlightRenderedMessage(htmls[0]!, 'warm up')
    const builds = highlightPatternBuilds.count
    for (const html of htmls) highlightRenderedMessage(html, 'message 17')
    assert.equal(highlightPatternBuilds.count - builds, 1)
    for (const html of htmls) highlightRenderedMessage(html, 'message 18')
    assert.equal(highlightPatternBuilds.count - builds, 2)
  })

  it('returns the same string, without splitting the HTML, when the query is absent', () => {
    const html = '<p>nothing to see</p>'
    assert.equal(highlightRenderedMessage(html, 'absent'), html)
  })

  it('timing: highlight pass over 5,000 messages', () => {
    const htmls = room(5000).map(item => `<p>${item.text} <code>x</code> more words in the message body</p>`)
    for (const query of ['message 17', 'zzzz']) {
      const start = performance.now()
      for (let round = 0; round < 5; round += 1) for (const html of htmls) highlightRenderedMessage(html, query)
      console.log(`highlight "${query}" over 5000 messages: ${((performance.now() - start) / 5).toFixed(2)} ms per keystroke`)
    }
  })
})

describe('message and task reference links', () => {
  it('detects whether HTML can hold a reference', () => {
    assert.equal(mayContainMessageReference('<p>hello</p>'), false)
    assert.equal(mayContainMessageReference('<p>see msg_12</p>'), true)
    assert.equal(mayContainMessageReference('<p>see task_3</p>'), true)
    assert.equal(mayContainMessageReference('<p>msg_ and task_x</p>'), false)
  })

  it('links references the same way, and returns plain HTML untouched', () => {
    const html = '<p>see msg_2 and task_4 and msg_99 <code>msg_2</code></p>'
    const linked = linkRenderedMessageReferences(html, new Set(['msg_2']), new Set(['task_4']))
    assert.match(linked, /data-message-reference-id="msg_2"/)
    assert.match(linked, /data-task-reference-id="task_4"/)
    assert.doesNotMatch(linked, /data-message-reference-id="msg_99"/)
    assert.equal(linked.match(/message-reference-link/g)!.length, 2 + 0)
    const plain = '<p>nothing</p>'
    assert.equal(linkRenderedMessageReferences(plain, new Set(['msg_2']), new Set()), plain)
    assert.equal(linkRenderedMessageReferences(html), html)
  })
})

describe('stable id sets', () => {
  it('syncIdSet edits only what differs', () => {
    const target = new Set(['a', 'b', 'c'])
    assert.equal(syncIdSet(target, ['a', 'b', 'c']), 0)
    assert.equal(syncIdSet(target, ['a', 'b', 'c', 'd']), 1)
    assert.equal(syncIdSet(target, ['b', 'd', 'e']), 3)
    assert.deepEqual([...target].sort(), ['b', 'd', 'e'])
    assert.equal(syncIdSet(target, []), 3)
    assert.equal(target.size, 0)
  })

  it('keep the set identity, follow the source, and never hold more than the source', async () => {
    const source = shallowRef(room(50).map(item => item.id))
    const scope = effectScope()
    const ids = scope.run(() => useStableIdSet(() => source.value))!
    const first = ids
    assert.equal(ids.size, 50)
    source.value = [...source.value, 'msg_51']
    await nextTick()
    assert.equal(ids, first)
    assert.ok(ids.has('msg_51'))
    source.value = source.value.slice(40)
    await nextTick()
    assert.equal(ids.size, 11)
    assert.ok(!ids.has('msg_1'))
    scope.stop()
  })

  it('wake only the computeds that looked up the id that changed (3,000 messages)', async () => {
    const ids = shallowReactive(new Set(room().map(item => item.id)))
    const htmls = room().map(item => `<p>${item.text}</p>`)
    let recomputes = 0
    // Model of DesktopChatMessage.linkedText after this change.
    const linked = htmls.map(html => computed(() => {
      recomputes += 1
      return mayContainMessageReference(html) ? linkRenderedMessageReferences(html, ids, undefined) : html
    }))
    const plain = htmls.map(() => computed(() => { recomputes += 1; return 'x' }))
    void plain
    linked.forEach(item => item.value)
    recomputes = 0
    ids.add(`msg_${ROOM_SIZE + 1}`)
    linked.forEach(item => item.value)
    const wokenByStableSet = recomputes
    // Model of the old code: a new Set per update is a new prop for every message.
    const oldProp = shallowRef<ReadonlySet<string>>(new Set(ids))
    const old = htmls.map(html => computed(() => { recomputes += 1; return linkRenderedMessageReferences(html, oldProp.value, undefined) }))
    old.forEach(item => item.value)
    recomputes = 0
    oldProp.value = new Set([...oldProp.value, `msg_${ROOM_SIZE + 2}`])
    old.forEach(item => item.value)
    const wokenByNewSet = recomputes
    console.log(`link-pass recomputes after one new message in a ${ROOM_SIZE} message room: before ${wokenByNewSet}, after ${wokenByStableSet}`)
    assert.equal(wokenByNewSet, ROOM_SIZE)
    assert.equal(wokenByStableSet, 0, `${ROOM_SIZE + 1} is not referenced by any message`)
    // A message that names the new id is woken, and links it.
    const referencing = computed(() => linkRenderedMessageReferences('<p>see msg_9000</p>', ids, undefined))
    assert.doesNotMatch(referencing.value, /message-reference-link/)
    ids.add('msg_9000')
    assert.match(referencing.value, /data-message-reference-id="msg_9000"/)
  })

  it('child rows are not re-rendered by a new message when the set prop keeps its identity', async () => {
    type Node = { children: Node[] }
    const { createApp } = createRenderer<Node, Node>({
      patchProp() {}, insert(child, parent) { parent.children.push(child) }, remove() {},
      createElement: () => ({ children: [] }), createText: () => ({ children: [] }), createComment: () => ({ children: [] }),
      setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null,
    })
    for (const mode of ['new-set-each-update', 'stable-set'] as const) {
      let rowRenders = 0
      const Row = defineComponent({
        props: { id: { type: String, required: true }, ids: { type: Object, required: true } },
        setup(props) { return () => { rowRenders += 1; return h('i', String(props.id)) } },
      })
      const count = ref(ROOM_SIZE)
      const stable = shallowReactive(new Set<string>())
      const App = defineComponent({
        setup() {
          return () => {
            const all = Array.from({ length: count.value }, (_, index) => `msg_${index + 1}`)
            const ids = mode === 'stable-set' ? (syncIdSet(stable, all), stable) : new Set(all)
            return h('div', all.map(id => h(Row, { key: id, id, ids })))
          }
        },
      })
      const app = createApp(App)
      app.mount({ children: [] })
      rowRenders = 0
      count.value += 1
      await nextTick()
      console.log(`row re-renders after one new message (${ROOM_SIZE} rows), ${mode}: ${rowRenders}`)
      assert.equal(rowRenders, mode === 'stable-set' ? 1 : ROOM_SIZE + 1)
      app.unmount()
    }
  })
})

describe('thread indicator memo', () => {
  const summary = (count: number) => ({
    count, unreadCount: 0, latest: null, latestPreview: 'p', latestTimestamp: null,
    participants: [{ key: 'a', displayName: 'A', color: null }], hasPartialHistory: false, loadingEarlier: false,
  })

  it('keeps the same object while the value is equal and replaces it when it changes', () => {
    const memo = createThreadIndicatorMemo()
    const first = memo.stable('msg_1', summary(1))
    assert.equal(memo.stable('msg_1', summary(1)), first)
    const changed = memo.stable('msg_1', summary(2))
    assert.notEqual(changed, first)
    assert.equal(memo.stable('msg_1', summary(2)), changed)
    const participants = { ...summary(2), participants: [{ key: 'b', displayName: 'A', color: null }] }
    assert.notEqual(memo.stable('msg_1', participants), changed)
  })

  it('drops entries for messages that left the list', () => {
    const memo = createThreadIndicatorMemo()
    for (let index = 1; index <= 10; index += 1) memo.stable(`msg_${index}`, summary(index))
    memo.retain(room(4))
    assert.equal(memo.size, 4)
    memo.retain(room(4))
    assert.equal(memo.size, 4)
  })
})

let provider: any
let roomMessages: any
let viteMessages: any
before(async () => {
  const vite = await createServer({ root: fileURLToPath(new URL('../..', import.meta.url)), appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  try {
    provider = await vite.ssrLoadModule('/renderer/src/composables/useRoomMessageLinkPreviews.ts')
    roomMessages = await vite.ssrLoadModule('/renderer/src/components/desktop/content/room-shell/useDesktopRoomMessages.ts')
    viteMessages = await vite.ssrLoadModule('/renderer/src/components/desktop/content/room-shell/messages.ts')
  } finally { await vite.close() }
})

describe('link previews per message', () => {
  const url = 'https://github.com/org/repo/pull/1'
  const preview = { kind: 'pull', number: 1, repository: 'org/repo', title: 'T', state: 'open', url }

  it('re-run only the message whose previews changed, in a 3,000 message room', async () => {
    const previousWindow = globalThis.window
    const roomId = ref('room'), repository = ref<string | null>('https://github.com/ORG/REPO'), scope = effectScope()
    let loads = 0
    Object.assign(globalThis, { window: { letagentsDesktop: { room: { getMessageLinkPreviews: async (id: string) => { loads += 1; return { room_id: id, previews: [preview] } } } } } })
    try {
      let context: any
      scope.run(() => { context = provider.useRoomMessageLinkPreviews(roomId, repository) })
      let perMessage = 0, wholeRoom = 0
      const ids = Array.from({ length: ROOM_SIZE }, (_, index) => `msg_${index + 1}`)
      const reads = ids.map(id => computed(() => { perMessage += 1; return context.previewsFor(id) }))
      // The old shape: every message depended on one room-wide revision.
      const oldReads = ids.map(id => computed(() => { wholeRoom += 1; void context.revision.value; return context.previewsFor(id) }))
      reads.forEach(item => item.value); oldReads.forEach(item => item.value)
      perMessage = 0; wholeRoom = 0

      const stop = context.track({ id: 'msg_7', urls: [url] })
      reads.forEach(item => item.value); oldReads.forEach(item => item.value)
      const afterTrack = { perMessage, wholeRoom }
      assert.equal(afterTrack.perMessage, 0, 'registering references changes no message by itself')
      perMessage = 0; wholeRoom = 0

      await new Promise(resolve => setTimeout(resolve, 90))
      assert.equal(loads, 1)
      reads.forEach(item => item.value); oldReads.forEach(item => item.value)
      console.log(`link preview recomputes when one message's previews load in a ${ROOM_SIZE} message room: before ${wholeRoom}, after ${perMessage}`)
      assert.equal(perMessage, 1)
      assert.equal(wholeRoom, ROOM_SIZE)
      assert.equal(reads[6]!.value[0].state, 'open')
      assert.deepEqual(reads[7]!.value, [])

      // Untracking clears that message again, and only that message.
      perMessage = 0
      stop()
      reads.forEach(item => item.value)
      assert.equal(perMessage, 1)
      assert.deepEqual(reads[6]!.value, [])

      // A context change tells every message once and drops the counters.
      context.track({ id: 'msg_8', urls: [url] })
      await new Promise(resolve => setTimeout(resolve, 90))
      reads.forEach(item => item.value)
      assert.equal(reads[7]!.value[0].state, 'open')
      perMessage = 0
      roomId.value = 'other'
      reads.forEach(item => item.value)
      assert.equal(perMessage, ROOM_SIZE)
      assert.deepEqual(reads[7]!.value, [])
    } finally { scope.stop(); Object.assign(globalThis, { window: previousWindow }) }
  })
})

describe('room message lists', () => {
  function mount(initial: DesktopRoomMessage[]) {
    const messages = shallowRef<readonly DesktopRoomMessage[]>(initial)
    const githubEventsVisible = ref(true)
    const roomInfo = ref({ identifier: 'room-1' })
    let api: any
    const app = createSSRApp({
      setup() {
        api = roomMessages.useDesktopRoomMessages({
          room: roomInfo, messages, githubEventsVisible, playRoomSound() {}, onMessageSent() {},
        })
        return () => h('div')
      },
    })
    return { api: () => api, messages, githubEventsVisible, app }
  }

  it('compute the visible list and the insight list from one pass of sort keys', async () => {
    const { renderToString } = await import('@vue/server-renderer')
    const harness = mount(room())
    await renderToString(harness.app)
    const api = harness.api()
    const builds = viteMessages.roomMessageSortKeyBuilds.count
    // Same message objects as an earlier test, so keys exist; a fresh room proves the count.
    const fresh = room()
    harness.messages.value = fresh
    const visible = api.visibleMessages.value
    const insight = api.roomMessagesForAgentInsight.value
    const built = viteMessages.roomMessageSortKeyBuilds.count - builds
    console.log(`sort keys built for visible + insight lists of ${ROOM_SIZE} messages: ${built} (before: one regex + parse per comparison)`)
    assert.equal(built, ROOM_SIZE)
    assert.equal(visible.length, ROOM_SIZE)
    assert.deepEqual(visible.map((item: DesktopRoomMessage) => item.id), insight.map((item: DesktopRoomMessage) => item.id))
    // GitHub events filter still applies on the shortcut path.
    const github = message(ROOM_SIZE + 1, { source: 'github', sender: 'github' })
    harness.messages.value = [...fresh, github]
    assert.equal(api.visibleMessages.value.some((item: DesktopRoomMessage) => item.id === github.id), true)
    harness.githubEventsVisible.value = false
    assert.equal(api.visibleMessages.value.some((item: DesktopRoomMessage) => item.id === github.id), false)
  })
})
