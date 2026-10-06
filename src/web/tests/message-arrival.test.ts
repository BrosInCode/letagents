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
  const bubble = element('bubble'), row = element('row'), viewport = element('viewport'), input = element('input')
  row.dataset.messageId = 'new'
  row.querySelector = (selector:string) => selector.includes('bubble') ? bubble : null
  viewport.querySelectorAll = (selector:string) => selector === '[data-motion-work]' ? [] : [row]
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
    for (const ordering of ['echo-first', 'ack-first', 'empty-room', 'scrolled-up', 'reduced-motion'] as const) {
      calls.length = 0
      let following = ordering !== 'scrolled-up'
      let follows = 0
      window.matchMedia = (() => ({ matches: ordering === 'reduced-motion', addEventListener() {}, removeEventListener() {} })) as any
      const messages = ref(ordering === 'empty-room' ? [] : [{id:'old',stableId:'old',text:'Old'}])
      let context!: ReturnType<typeof motion.provideRoomMessageMotion>
      const Child = defineComponent({setup() {
        motion.useRoomMessageMotion({element:ref(viewport),messages:() => messages.value,scope:() => 'room',ready:() => true,following:() => following,
          scrollToLatest:() => { follows++; following = true }})
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
        } else if (ordering === 'reduced-motion') {
          assert.deepEqual(calls, [], 'reduced motion still navigates to the sent message without movement')
        } else {
          assert.equal(calls.filter(call => call.name === 'bubble clone' && call.duration === 280).length, 1)
        }
        assert.equal(follows, 1, 'an own send navigates once, even from history or with a late acknowledgement')
        assert.equal(context.peekId(), undefined, 'the pending composer origin is consumed')
        messages.value = [...messages.value]
        await settle()
        assert.deepEqual(calls, firstArrival, 'subsequent updates do not replay the message')
        following = false
        messages.value = [...messages.value, {id:'incoming',stableId:'incoming',text:'Someone else replied'}]
        await settle()
        assert.equal(follows, 1, 'incoming messages never pull a reader away from history')
        assert.deepEqual(calls, firstArrival, 'incoming messages off-screen do not animate')
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
  const bubble = element(), row = element(), viewport = element()
  viewport.clientHeight = 600
  row.querySelector = (selector: string) => selector.includes('bubble') ? bubble : null
  const style: any = {paddingLeft:'13px',paddingTop:'9px', [Symbol.iterator]: function* () {}}
  Object.assign(globalThis, {
    document: {body: {append: (layer: any) => layers.push(layer)}, createElement: () => element()},
    getComputedStyle: () => style,
  })
  try {
    const animator = createRoomMessageAnimator(() => viewport)
    animator.send(row, {...rect, top:500} as DOMRect, false)
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

test('work handoff stays visible briefly, consumes only its causal agent reply, and expires or clears safely', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
  const messages = ref<any[]>([{ id: 'request', stableId: 'request', text: 'Request' }])
  const a = { session: 'a', key: 'owner/a', after: 'request' }, b = { session: 'b', key: 'owner/b', after: 'request' }
  const active = ref([a, b]), room = ref('one'), enabled = ref(true)
  const scope = effectScope()
  const handoff = scope.run(() => motion.useRoomWorkHandoff({ work: () => active.value, identity: value => value,
    after: value => value.after, messages: () => messages.value, scope: () => room.value, enabled: () => enabled.value }))!
  const reply = (id: string, session: string, key = `owner/${session}`) => ({ id, stableId: id, text: id, session, key })
  try {
    active.value = []; await nextTick()
    t.mock.timers.tick(600)
    assert.equal(handoff.work.value.length, 2, 'both actual work rows bridge a separate work-clear update')
    messages.value.push({ id:'github-event', stableId:'github-event', text:'Unrelated room activity' }); await nextTick()
    assert.equal(handoff.work.value.length,2,'ambient messages do not end another agent’s turn')
    messages.value.push(reply('b-reply', 'b')); await nextTick()
    assert.deepEqual(handoff.work.value.map(item => item.session), ['a'], 'B cannot consume A’s thinking row')
    messages.value.push(reply('wrong-session', 'new-a', 'owner/a')); await nextTick()
    assert.equal(handoff.work.value.length, 1, 'exact sessions take precedence over a matching durable key')
    messages.value.push(reply('a-reply', 'a')); await nextTick()
    assert.equal(handoff.work.value.length, 0)
    messages.value = [...messages.value]; await nextTick()
    assert.equal(handoff.work.value.length, 0, 'a replay cannot restore a consumed turn')

    messages.value.push({ id: 'request-2', stableId: 'request-2', text: 'Again' })
    active.value = [{ ...a, after: 'request-2' }]; await nextTick()
    active.value = []; await nextTick()
    t.mock.timers.tick(1001)
    assert.equal(handoff.work.value.length, 0, 'no-reply turns expire after one second')
    messages.value = [...messages.value]; await nextTick()
    assert.equal(handoff.work.value.length, 0, 'later metadata updates cannot rearm expired work')

    for (const boundary of ['new-turn', 'room', 'history', 'interrupt'] as const) {
      messages.value = [{ id: 'request', stableId: 'request', text: 'Request' }]
      active.value = [a]; enabled.value = true; await nextTick()
      active.value = []; await nextTick()
      assert.equal(handoff.work.value.length, 1)
      if (boundary === 'new-turn') messages.value.push({ id: 'next', stableId: 'next', text: 'Next' })
      if (boundary === 'new-turn') active.value = [{ ...a, after: 'next' }]
      if (boundary === 'room') room.value = 'other'
      if (boundary === 'history') enabled.value = false
      if (boundary === 'interrupt') handoff.clear()
      await nextTick()
      assert.equal(handoff.work.value.some(item => item.after === 'request'), false, boundary)
    }
  } finally { scope.stop(); t.mock.timers.reset() }
})

test('real reply watcher transforms retained work once across split updates and repeated turns', async () => {
  const saved = { document: globalThis.document, window: globalThis.window, getComputedStyle: globalThis.getComputedStyle }
  const calls: {name:string;duration:number}[] = []
  const rect = {left:20,top:100,right:220,bottom:150,width:200,height:50}
  function element(name:string): any {
    return { style:{opacity:''}, dataset:{}, isConnected:true, clientHeight:600,
      getBoundingClientRect:() => ({...rect}), querySelectorAll:() => [], querySelector:() => null,
      setAttribute() {}, removeAttribute() {}, append() {}, remove() {}, addEventListener() {}, removeEventListener() {},
      cloneNode:() => element(`${name} clone`),
      animate(_frames:unknown, options:{duration:number}) {
        calls.push({name,duration:options.duration})
        let reject!: (error:Error) => void
        return {finished:new Promise((_resolve,r) => {reject=r}),cancel:() => reject(new Error('cancelled'))}
      } }
  }
  let workRows:any[] = [], rows:any[] = [], following = true, reduced = false, follows = 0
  const viewport = element('viewport')
  viewport.getBoundingClientRect = () => ({...rect,bottom:700,height:600})
  viewport.querySelectorAll = (selector:string) => selector === '[data-motion-work]' ? workRows : rows
  Object.assign(globalThis, {
    document:{visibilityState:'visible',body:{append() {}},createElement:() => element('overlay')},
    window:{matchMedia:() => ({get matches() {return reduced},addEventListener() {},removeEventListener() {}}),addEventListener() {},removeEventListener() {}},
    getComputedStyle:() => ({[Symbol.iterator]:function* () {}}),
  })
  const renderer = createRenderer({createComment:() => ({}),createText:() => ({}),createElement:() => ({}),insert() {},remove() {},setText() {},setElementText() {},patchProp() {},parentNode:() => null,nextSibling:() => null})
  const messages = ref<any[]>([{id:'request',stableId:'request',text:'Request'}]), active = ref<any[]>([])
  let handoff!: ReturnType<typeof motion.useRoomWorkHandoff<any>>
  const Component = defineComponent({setup() {
    handoff = motion.useRoomWorkHandoff({work:() => active.value,identity:value => value,after:value => value.after,
      messages:() => messages.value,scope:() => 'room',enabled:() => following})
    motion.useRoomMessageMotion({element:ref(viewport),messages:() => messages.value.map(message => ({...message})),scope:() => 'room',ready:() => true,
      following:() => following,scrollToLatest:() => {follows++},onInterrupt:handoff.clear})
    return () => {
      workRows = handoff.work.value.map(value => {
        const work = element('work'); work.dataset = {motionSession:value.session,motionAgent:value.key,motionAfter:value.after}
        work.querySelector = () => element('work detail'); return work
      })
      rows = messages.value.map(value => {
        const row = element(value.id), bubble = element(`${value.id} bubble`); row.dataset.messageId = value.id
        row.querySelector = (selector:string) => selector.includes('bubble') ? bubble : null; return row
      })
      return null
    }
  }})
  const app = renderer.createApp(Component)
  const settle = async () => {await nextTick();await nextTick();await nextTick()}
  try {
    app.mount({})
    for (const turn of [1,2]) {
      active.value = [{session:'a',key:'owner/a',after:messages.value.at(-1).id}]; await settle()
      active.value = []; await settle()
      assert.equal(workRows.length,1,'work remains in the actual rendered set during the handoff gap')
      const id=`reply-${turn}`
      messages.value.push({id,stableId:id,text:'Reply',session:'a',key:'owner/a'}); await settle()
      assert.equal(workRows.length,0,'reply replaces the retained row')
      assert.equal(calls.filter(call => call.name===`${id} bubble`&&call.duration===440).length,1)
      const count=calls.length
      messages.value=[...messages.value]; await settle()
      assert.equal(calls.length,count,'replaying the reply never repeats entrance')
    }
    for(const mode of ['history','reduced'] as const) {
      active.value=[{session:'a',key:'owner/a',after:messages.value.at(-1).id}]; await settle()
      following=mode!=='history'; reduced=mode==='reduced'
      active.value=[]; await settle()
      assert.equal(workRows.length,0,'navigation/reduced motion does not preserve a stale visual origin')
      const count=calls.length
      messages.value.push({id:mode,stableId:mode,text:'Reply',session:'a',key:'owner/a'}); await settle()
      assert.equal(calls.length,count)
    }
    assert.equal(follows,0,'incoming replies never request scrolling to latest')
  } finally {app.unmount();Object.assign(globalThis,saved)}
})
