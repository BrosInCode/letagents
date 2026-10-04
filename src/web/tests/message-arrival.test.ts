import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { createRenderer, defineComponent, effectScope, h, nextTick, readonly, ref } from 'vue'

import {
  type MessageListGrowth,
  getAppendedMessageIds,
  mergeMessageArrivalIds,
  watchMessageListGrowth,
} from '../src/components/room/messageArrival'

test('message arrival only identifies genuinely appended messages', () => {
  assert.deepEqual(getAppendedMessageIds([], ['m1', 'm2']), [])
  assert.deepEqual(getAppendedMessageIds(['m1', 'm2'], ['m1', 'm2', 'm3']), ['m3'])
  assert.deepEqual(getAppendedMessageIds(['m1', 'm2'], ['m0', 'm1', 'm2']), [])
  assert.deepEqual(getAppendedMessageIds(['m1', 'm3'], ['m1', 'm2', 'm3']), [])
  assert.deepEqual(getAppendedMessageIds(['m1'], ['other-room-message']), [])
})

test('message arrival preserves in-flight ids when another burst arrives', () => {
  assert.deepEqual(
    [...mergeMessageArrivalIds(new Set(['m1']), ['m2', 'm3'])],
    ['m1', 'm2', 'm3'],
  )
})

function watchGrowth(initialIds: string[]) {
  // Mirrors useRoom: the list is a ref exposed read-only, and live messages
  // are pushed onto the same array (appendRoomMessage).
  const messages = ref(initialIds.map((id) => ({ id })))
  const exposed = readonly(messages)
  const seen: MessageListGrowth[] = []
  const scope = effectScope()
  scope.run(() => watchMessageListGrowth(() => exposed.value, (growth) => { seen.push(growth) }))
  return { messages, seen, stop: () => scope.stop() }
}

test('message list growth sees live messages pushed onto the same array', async () => {
  const { messages, seen, stop } = watchGrowth(['m1', 'm2'])
  messages.value.push({ id: 'm3' })
  await nextTick()
  messages.value.push({ id: 'm4' }, { id: 'm5' })
  await nextTick()
  assert.deepEqual(seen, [
    { prepended: false, appendedIds: ['m3'], addedCount: 1 },
    { prepended: false, appendedIds: ['m4', 'm5'], addedCount: 2 },
  ])
  stop()
})

test('message list growth handles replaced arrays, prepends, and shrinking', async () => {
  const { messages, seen, stop } = watchGrowth(['m2', 'm3'])
  messages.value = [...messages.value, { id: 'm4' }]
  await nextTick()
  messages.value = [{ id: 'm0' }, { id: 'm1' }, ...messages.value]
  await nextTick()
  messages.value = []
  await nextTick()
  messages.value = [{ id: 'other-room-1' }, { id: 'other-room-2' }]
  await nextTick()
  assert.deepEqual(seen, [
    { prepended: false, appendedIds: ['m4'], addedCount: 1 },
    { prepended: true, appendedIds: [], addedCount: 2 },
    { prepended: false, appendedIds: [], addedCount: 2 },
  ])
  stop()
})

test('message list growth diffs a push and a replace in the same tick once', async () => {
  const { messages, seen, stop } = watchGrowth(['m1', 'm2'])
  messages.value.push({ id: 'm3' })
  messages.value = [...messages.value, { id: 'm4' }]
  await nextTick()
  assert.deepEqual(seen, [{ prepended: false, appendedIds: ['m3', 'm4'], addedCount: 2 }])
  stop()
  messages.value.push({ id: 'm5' })
  await nextTick()
  assert.equal(seen.length, 1)
})

import { appendedMotionMessages, sameMotionAgent } from '../../../shared/ui/room-message-motion'
import { useRoomWorkIndicators } from '../src/components/room/roomWorkIndicators'
let motion: typeof import('../../../shared/ui/useRoomMessageMotion')
before(async () => {
  // Load shared Vue code through the app's normal dependency deduplication.
  const vite = await createServer({root:fileURLToPath(new URL('..', import.meta.url)),appType:'custom',logLevel:'silent',server:{middlewareMode:true}})
  try { motion = await vite.ssrLoadModule(fileURLToPath(new URL('../../../shared/ui/useRoomMessageMotion.ts', import.meta.url))) as typeof motion }
  finally { await vite.close() }
})

test('motion follows optimistic identity through acknowledgement and skips history/re-entry', () => {
  const m = (id: string, stableId = id) => ({ id, stableId, text: id })
  assert.deepEqual(appendedMotionMessages(['a', 'send-1'], [m('a'), m('msg_2', 'send-1')]), [])
  assert.deepEqual(appendedMotionMessages(['a', 'send-1'], [m('a'), m('msg_2', 'send-1'), m('b')]).map(m => m.id), ['b'])
  assert.deepEqual(appendedMotionMessages(['a'], [m('older'), m('a')]), [])
  assert.deepEqual(appendedMotionMessages([], [m('history')]), [])
  assert.deepEqual(appendedMotionMessages(['room-a'], [m('room-b')]), [])
})

test('thinking motion uses exact session first, then durable key, never display name', () => {
  assert.equal(sameMotionAgent({session:'one',key:'owner/agent'}, {session:'two',key:'owner/agent'}), false)
  assert.equal(sameMotionAgent({session:'one',key:'owner/agent'}, {session:'one',key:'old-key'}), true)
  assert.equal(sameMotionAgent({key:'Owner/Agent'}, {key:'owner/agent'}), true)
  assert.equal(sameMotionAgent({}, {}), false)
})

test('web thinking retires only after its agent replies and resets on a new turn or room', async () => {
  const presence = ref<any[]>([]), messages = ref<any[]>([{id:'msg_1'}]), room = ref('one')
  const scope = effectScope()
  let indicators: ReturnType<typeof useRoomWorkIndicators>
  scope.run(() => { indicators = useRoomWorkIndicators(() => presence.value, () => messages.value, () => room.value) })
  const agent = {agent_session_id:'one',agent_key:'owner/agent',display_name:'Willow',status:'working',freshness:'active',status_text:'Thinking'}
  presence.value = [agent, {...agent,agent_session_id:'two',agent_key:'other/agent'}]
  await nextTick()
  assert.equal(indicators!.value.length, 2)
  messages.value.push({id:'msg_2',agent_identity:{agent_session_id:'two',agent_key:'other/agent'}})
  await nextTick()
  assert.deepEqual(indicators!.value.map(work => work.session), ['one'])
  messages.value.push({id:'msg_3',agent_identity:{agent_session_id:'one',agent_key:'owner/agent'}})
  await nextTick()
  assert.equal(indicators!.value.length, 0)
  presence.value = presence.value.map(agent => ({...agent,status_text:'Old heartbeat'}))
  await nextTick()
  assert.equal(indicators!.value.length, 0, 'a stale working heartbeat must not resurrect a completed turn')
  presence.value = []; await nextTick()
  presence.value = [agent]; await nextTick()
  assert.equal(indicators!.value[0].after, 'msg_3')
  room.value = 'two'; presence.value = []; messages.value = []; await nextTick()
  assert.equal(indicators!.value.length, 0)
  scope.stop()
})

test('web thinking recovers a missed idle transition only with a new request and fresh work', async () => {
  const at = (second: number) => new Date(Date.UTC(2026, 9, 4, 0, 0, second)).toISOString()
  const identity = { agent_session_id: 'one', agent_key: 'owner/agent' }
  const agent = {...identity, display_name: 'Willow', status: 'working', freshness: 'active', updated_at: at(1)}
  const presence = ref<any[]>([agent]), messages = ref<any[]>([{id:'request-1',source:'browser',timestamp:at(0)}])
  const scope = effectScope()
  const indicators = scope.run(() => useRoomWorkIndicators(() => presence.value, () => messages.value, () => 'room'))!
  try {
    messages.value.push({id:'reply-1',source:'agent',timestamp:at(2),agent_identity:identity})
    await nextTick()
    assert.equal(indicators.value.length, 0)
    presence.value = [{...agent,updated_at:at(3)}]
    await nextTick()
    assert.equal(indicators.value.length, 0, 'a newer heartbeat without a request stays retired')
    messages.value.push({id:'github-event',source:'github',timestamp:at(4)})
    messages.value.push({id:'own-followup',source:'agent',timestamp:at(5),agent_identity:identity})
    presence.value = [{...agent,updated_at:at(6)}]
    await nextTick()
    assert.equal(indicators.value.length, 0, 'ambient events and the same agent cannot rearm work')
    messages.value.push({id:'request-2',source:'browser',timestamp:at(7)})
    await nextTick()
    assert.equal(indicators.value.length, 0, 'a new request with cached working presence stays retired')
    presence.value = [{...agent,updated_at:at(8)}]
    await nextTick()
    assert.equal(indicators.value.length, 1)
    assert.equal(indicators.value[0].after, 'request-2')
    messages.value.push({id:'reply-2',source:'agent',timestamp:at(9),agent_identity:identity})
    await nextTick()
    assert.equal(indicators.value.length, 0)
    messages.value.push({id:'request-3',source:'browser',timestamp:at(10)})
    messages.value.push({id:'reply-3',source:'agent',timestamp:at(11),agent_identity:identity})
    presence.value = [{...agent,updated_at:at(12)}]
    await nextTick()
    assert.equal(indicators.value.length, 0, 'an already-completed turn never flashes a new indicator')
  } finally { scope.stop() }
})

test('real send watcher animates each message once across echo/ack order and empty rooms', async () => {
  const saved = { document: globalThis.document, window: globalThis.window, getComputedStyle: globalThis.getComputedStyle }
  const calls: {name:string; duration:number}[] = []
  const rect = {left:20,top:100,right:220,bottom:150,width:200,height:50}
  function element(name: string): any {
    return {
      style: {opacity:''}, dataset:{}, isConnected:true, clientHeight:600,
      getBoundingClientRect: () => rect, querySelectorAll: () => [], querySelector: () => null,
      setAttribute() {}, removeAttribute() {}, append() {}, remove() {}, addEventListener() {}, removeEventListener() {},
      cloneNode: () => element(`${name} clone`),
      animate(_frames: unknown, options: {duration:number}) {
        calls.push({name,duration:options.duration})
        let reject!: (error:Error) => void
        return {finished:new Promise((_resolve, r) => {reject=r}), cancel:() => reject(new Error('cancelled'))}
      },
    }
  }
  const bubble = element('bubble'), row = element('row'), composer = element('composer'), viewport = element('viewport'), input = element('input')
  row.dataset.messageId = 'new'
  row.querySelector = (selector:string) => selector.includes('bubble') ? bubble : null
  viewport.querySelectorAll = (selector:string) => selector === '[data-motion-work]' ? [] : [row]
  input.closest = () => composer
  Object.assign(globalThis, {
    document:{activeElement:input,visibilityState:'visible',body:{append() {}},createElement:() => element('layer')},
    window:{matchMedia:() => ({matches:false,addEventListener() {},removeEventListener() {}}),addEventListener() {},removeEventListener() {}},
    getComputedStyle:() => ({paddingLeft:'13px',paddingTop:'9px',[Symbol.iterator]:function* () {}}),
  })
  const renderer = createRenderer({
    createComment:() => ({}), createText:() => ({}), createElement:() => ({}),
    insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {}, parentNode:() => null, nextSibling:() => null,
  })
  const settle = async () => { await nextTick(); await nextTick(); await nextTick() }
  try {
    for (const ordering of ['echo-first', 'ack-first', 'empty-room'] as const) {
      calls.length = 0
      const messages = ref(ordering === 'empty-room' ? [] : [{id:'old',stableId:'old',text:'Old'}])
      let context!: ReturnType<typeof motion.provideRoomMessageMotion>
      const Child = defineComponent({setup() {
        motion.useRoomMessageMotion({element:ref(viewport),messages:() => messages.value,scope:() => 'room',ready:() => true,following:() => true})
        return () => null
      }})
      const Parent = defineComponent({setup() {context = motion.provideRoomMessageMotion(() => 'room'); return () => h(Child)}})
      const app = renderer.createApp(Parent)
      app.mount({})
      try {
        context.capture('Hello', input)
        const ack = context.confirmation('Hello')
        if (ordering !== 'echo-first') ack('new')
        messages.value = [...messages.value, {id:'new',stableId:'new',text:'Hello'}]
        await settle()
        const firstArrival = [...calls]
        if (ordering === 'echo-first') {
          assert.deepEqual(firstArrival, [{name:'row',duration:200}])
          ack('new')
          await settle()
          assert.deepEqual(calls, firstArrival, 'a late ack must not replay the visible echo')
        } else {
          assert.equal(calls.filter(call => call.name === 'bubble clone' && call.duration === 420).length, 1)
        }
        assert.equal(context.peekId(), undefined, 'the pending composer origin is consumed')
        messages.value = [...messages.value]
        await settle()
        assert.deepEqual(calls, firstArrival, 'subsequent updates do not replay the message')
      } finally { app.unmount() }
      await settle()
    }
  } finally { Object.assign(globalThis, saved) }
})

import { createRoomMessageAnimator } from '../../../shared/ui/room-message-motion'

test('interrupting a send restores the real bubble and removes inert animation copies', async () => {
  const saved = { document: globalThis.document, getComputedStyle: globalThis.getComputedStyle }
  const active: any[] = [], layers: any[] = []
  const rect = {left:20,top:100,right:220,bottom:150,width:200,height:50}
  function element(): any {
    return {
      style: {opacity:''}, children: [], attributes: {}, isConnected: true,
      getBoundingClientRect: () => rect,
      setAttribute(name: string, value: string) { this.attributes[name] = value }, removeAttribute() {},
      querySelectorAll: () => [],
      append(child: any) { this.children.push(child) },
      remove() { this.isConnected = false },
      cloneNode: () => element(),
      animate() {
        let reject: (error: Error) => void
        const animation = {finished: new Promise((_resolve, r) => {reject = r}), cancel: () => reject(new Error('cancelled'))}
        active.push(animation); return animation
      },
    }
  }
  const bubble = element(), row = element(), composer = element(), viewport = element()
  viewport.clientHeight = 600
  row.querySelector = (selector: string) => selector.includes('bubble') ? bubble : null
  const style: any = {paddingLeft:'13px',paddingTop:'9px', [Symbol.iterator]: function* () {}}
  Object.assign(globalThis, {
    document: {body: {append: (layer: any) => layers.push(layer)}, createElement: () => element()},
    getComputedStyle: () => style,
  })
  try {
    const animator = createRoomMessageAnimator(() => viewport)
    animator.send(row, {...rect, top:500} as DOMRect, composer, false)
    assert.equal(bubble.style.opacity, '0')
    assert.equal(layers[0].inert, true)
    assert.equal(layers[0].attributes['aria-hidden'], 'true')
    animator.cancel()
    assert.equal(bubble.style.opacity, '')
    assert.equal(layers[0].isConnected, false)
    await Promise.resolve()
    animator.cancel()
    assert.equal(bubble.style.opacity, '', 'cancel remains safe after animation rejection cleanup')
  } finally { Object.assign(globalThis, saved) }
})
