import assert from 'node:assert/strict'
import test from 'node:test'
import { effectScope, nextTick, ref } from 'vue'
import { decideMessageRevealAction } from '../src/components/room/messageReveal'
import { isValidMessageId } from '../src/domain/roomRoutes'

test('simulation: fresh load of newest message (msg_1549) waits for bootstrap and scrolls', async () => {
  const scope = effectScope()
  await scope.run(async () => {
    const isConnected = ref(false)
    const messagesLoaded = ref(false)
    const messages = ref<Array<{ id: string }>>([])
    const hasOlder = ref(false)
    const isLoadingOlder = ref(false)
    const revealMessageId = ref<string | null>(null)
    const actions: string[] = []

    const queryMessage = ref('msg_1549')

    // Watcher in Room.vue: waits for both connected and messagesLoaded
    const handlePermalink = (targetId: string) => {
      revealMessageId.value = targetId
    }

    const checkWatcher = () => {
      if (!isConnected.value || !messagesLoaded.value || !isValidMessageId(queryMessage.value)) return
      handlePermalink(queryMessage.value)
    }

    // Step 1: Stream connects, but bootstrap has not finished
    isConnected.value = true
    checkWatcher()
    assert.equal(revealMessageId.value, null, 'must not trigger reveal before initial messages load')

    // Step 2: Bootstrap completes with first page holding msg_1549
    messages.value = Array.from({ length: 149 }, (_, i) => ({ id: `msg_${1549 - i}` }))
    hasOlder.value = true
    messagesLoaded.value = true
    checkWatcher()
    assert.equal(revealMessageId.value, 'msg_1549', 'triggers reveal once history is ready')

    // Step 3: MessageList evaluates reveal
    const found = messages.value.some((m) => m.id === revealMessageId.value)
    const action = decideMessageRevealAction({
      found,
      historyReady: messagesLoaded.value,
      hasOlder: hasOlder.value,
      loading: isLoadingOlder.value,
      pagesRequested: 0,
    })
    assert.equal(action, 'scroll', 'newest message is found in initial history and scrolls')
  })
  scope.stop()
})

test('simulation: fresh load of older message (msg_1400) pages back without premature unavailable notice', async () => {
  const scope = effectScope()
  await scope.run(async () => {
    const isConnected = ref(false)
    const messagesLoaded = ref(false)
    // Page 1 holds msg_1549 down to msg_1401 (149 messages)
    const messages = ref<Array<{ id: string }>>([])
    const hasOlder = ref(false)
    const isLoadingOlder = ref(false)
    const revealMessageId = ref<string | null>(null)
    let pagesRequested = 0
    const emitted: string[] = []

    const targetId = 'msg_1400'

    // Stream connects
    isConnected.value = true
    // Before bootstrap: decision must wait
    const preBootstrapAction = decideMessageRevealAction({
      found: false,
      historyReady: messagesLoaded.value,
      hasOlder: false,
      loading: false,
      pagesRequested: 0,
    })
    assert.equal(preBootstrapAction, 'wait', 'must wait before bootstrap is ready')

    // Bootstrap arrives
    messages.value = Array.from({ length: 149 }, (_, i) => ({ id: `msg_${1549 - i}` }))
    hasOlder.value = true
    messagesLoaded.value = true
    revealMessageId.value = targetId

    // Tick 1: MessageList evaluates reveal for msg_1400
    let found = messages.value.some((m) => m.id === targetId)
    let action = decideMessageRevealAction({
      found,
      historyReady: messagesLoaded.value,
      hasOlder: hasOlder.value,
      loading: isLoadingOlder.value,
      pagesRequested,
    })
    assert.equal(action, 'load_older', 'not on page 1, requests next older page')

    // Simulate loadOlder in flight
    pagesRequested += 1
    isLoadingOlder.value = true

    // Tick 2: While load is in flight, watcher runs
    action = decideMessageRevealAction({
      found: false,
      historyReady: messagesLoaded.value,
      hasOlder: hasOlder.value,
      loading: isLoadingOlder.value,
      pagesRequested,
    })
    assert.equal(action, 'wait', 'must WAIT while page load is in flight - never report unavailable!')

    // Tick 3: Page 2 arrives (msg_1400 down to msg_1251)
    const page2 = Array.from({ length: 150 }, (_, i) => ({ id: `msg_${1400 - i}` }))
    messages.value = [...page2, ...messages.value]
    isLoadingOlder.value = false

    // MessageList evaluates again
    found = messages.value.some((m) => m.id === targetId)
    action = decideMessageRevealAction({
      found,
      historyReady: messagesLoaded.value,
      hasOlder: hasOlder.value,
      loading: isLoadingOlder.value,
      pagesRequested,
    })
    assert.equal(action, 'scroll', 'msg_1400 is now found in DOM after older page arrives')
  })
  scope.stop()
})

test('simulation: room already open and scrolled down; target msg_1400 pages back cleanly', async () => {
  const scope = effectScope()
  await scope.run(async () => {
    const messagesLoaded = ref(true)
    const messages = ref<Array<{ id: string }>>(
      Array.from({ length: 149 }, (_, i) => ({ id: `msg_${1549 - i}` })),
    )
    const hasOlder = ref(true)
    const isLoadingOlder = ref(false)
    let pagesRequested = 0
    const targetId = 'msg_1400'

    // Step 1: User navigates to ?message=msg_1400
    let found = messages.value.some((m) => m.id === targetId)
    let action = decideMessageRevealAction({
      found,
      historyReady: messagesLoaded.value,
      hasOlder: hasOlder.value,
      loading: isLoadingOlder.value,
      pagesRequested,
    })
    assert.equal(action, 'load_older')

    // Step 2: In-flight load
    pagesRequested += 1
    isLoadingOlder.value = true

    // In-flight tick must wait
    action = decideMessageRevealAction({
      found: false,
      historyReady: messagesLoaded.value,
      hasOlder: hasOlder.value,
      loading: isLoadingOlder.value,
      pagesRequested,
    })
    assert.equal(action, 'wait')

    // Step 3: Page arrives with msg_1400
    const page2 = Array.from({ length: 150 }, (_, i) => ({ id: `msg_${1400 - i}` }))
    messages.value = [...page2, ...messages.value]
    isLoadingOlder.value = false

    found = messages.value.some((m) => m.id === targetId)
    action = decideMessageRevealAction({
      found,
      historyReady: messagesLoaded.value,
      hasOlder: hasOlder.value,
      loading: isLoadingOlder.value,
      pagesRequested,
    })
    assert.equal(action, 'scroll')
  })
  scope.stop()
})
