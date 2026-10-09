import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'
import { createSSRApp, h, markRaw, nextTick, provide, ref } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { createServer } from 'vite'

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
}

const chatMessage = source('../src/components/room/ChatMessage.vue')
const messageMeta = source('../src/components/room/chat-message/MessageMeta.vue')

test('web messages replace the browser context menu with the message menu', () => {
  assert.match(chatMessage, /@contextmenu\.stop="openContextMenu"/)
  assert.match(chatMessage, /Copy message<\/button>/)
  assert.match(chatMessage, /Copy link to message<\/button>/)
  assert.match(chatMessage, /Reply<\/button>/)
  assert.match(chatMessage, /web-message-context-menu-separator/)
  assert.match(chatMessage, /Message info<\/button>/)
})

test('native context menus survive on links, controls, media, and text selections', () => {
  // preventDefault lives in the handler, not the template, so deferral paths keep the browser menu.
  assert.doesNotMatch(chatMessage, /@contextmenu\.prevent="openContextMenu"/)
  assert.match(chatMessage, /a\[href\], button, input, textarea, select, \[contenteditable="true"\], img, video, audio/)
  assert.match(chatMessage, /target\?\.closest\(NATIVE_MENU_TARGETS\)\) return/)
  assert.match(chatMessage, /selection\.containsNode\(target, true\)\) return/)
  assert.match(chatMessage, /event\.preventDefault\(\)/)
})

test('the menu dismisses on outside press, Escape, and window blur', () => {
  assert.match(chatMessage, /document\.addEventListener\('pointerdown', handleMenuDismiss, true\)/)
  assert.match(chatMessage, /document\.addEventListener\('keydown', handleMenuDismiss, true\)/)
  assert.match(chatMessage, /window\.addEventListener\('blur', handleMenuDismiss\)/)
})

test('capture-phase dismissal ignores presses inside the menu so item clicks execute', () => {
  assert.match(
    chatMessage,
    /event\.type === 'pointerdown' && event\.target instanceof Node && contextMenuRef\.value\?\.contains\(event\.target\)\) return/,
  )
  assert.doesNotMatch(chatMessage, /@pointerdown\.stop/)
})

test('the menu is a keyboard-operable ARIA menu with focus transfer and restoration', () => {
  assert.match(chatMessage, /aria-label="Message actions"/)
  assert.match(chatMessage, /@keydown="handleMenuKeydown"/)
  // Focus moves to the first item on open…
  assert.match(chatMessage, /nextTick\(\(\) => \{\s*contextMenuRef\.value\?\.querySelector<HTMLElement>\('\[role="menuitem"\]'\)\?\.focus\(\)/)
  // …arrows cycle through items…
  assert.match(chatMessage, /ArrowDown'\) \{\s*event\.preventDefault\(\)\s*items\[\(activeIndex \+ 1\) % items\.length\]\.focus\(\)/)
  assert.match(chatMessage, /ArrowUp'\) \{\s*event\.preventDefault\(\)\s*items\[\(activeIndex - 1 \+ items\.length\) % items\.length\]\.focus\(\)/)
  // …and Escape restores focus to where it was before the menu opened.
  assert.match(chatMessage, /closeContextMenu\(event\.type === 'keydown'\)/)
  assert.match(chatMessage, /contextMenuRestoreFocus\?\.isConnected\) contextMenuRestoreFocus\.focus\(\)/)
})

test('Message info ships ungated: the hover affordance has no feature flag', () => {
  assert.doesNotMatch(messageMeta, /messageInfoEnabled|messageInfoSurfaceEnabled|featureFlags/)
  assert.match(messageMeta, /aria-label="Message info"/)
})

let vite: any, Chat: any, pins: any, reactions: any, unreadMenuKey: any
const originalStorage = globalThis.localStorage
before(async () => {
  Object.assign(globalThis, { localStorage: { getItem: () => null, setItem() {}, removeItem() {} } })
  vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  Chat = (await vite.ssrLoadModule('/src/components/room/ChatMessage.vue')).default
  pins = await vite.ssrLoadModule('/src/composables/roomMessagePins.ts')
  reactions = await vite.ssrLoadModule('/src/composables/roomMessageReactions.ts')
  ;({ unreadMenuKey } = await vite.ssrLoadModule('/@fs' + fileURLToPath(new URL('../../../shared/room-unread-client.ts', import.meta.url))))
})
after(async () => { await vite?.close(); Object.assign(globalThis, { localStorage: originalStorage }) })
class AuditElement {
  isConnected = true
  disabled = false
  link = false
  constructor(readonly label = '') { markRaw(this) }
  focus() { if (!this.disabled) (document as any).activeElement = this }
  closest() { return this.link ? this : null }
}
async function webMenuAudit(t: any, flags = 46, extra: Record<string, unknown> = {}) {
  const originals = { window: globalThis.window, document: globalThis.document, Element: globalThis.Element, HTMLElement: globalThis.HTMLElement, Node: globalThis.Node }
  const invoker = new AuditElement('composer'), target = new AuditElement('message')
  target.link = Boolean(flags & 1)
  const doc = Object.assign(new EventTarget(), { activeElement: invoker })
  const win = Object.assign(new EventTarget(), { innerWidth: 800, innerHeight: 600, getSelection: () => null })
  Object.assign(globalThis, { document: doc, window: win, Element: AuditElement, HTMLElement: AuditElement, Node: AuditElement })
  t.after(() => Object.assign(globalThis, originals))
  let vm: any
  const OpenChat = { ...Chat, setup(props: any, context: any) {
    vm = Chat.setup(props, context)
    vm.openContextMenu({ target, clientX: 799, clientY: 599, preventDefault() {} })
    return vm
  } }
  const props = { message: { id: 'msg_12', sender: 'Ada', text: 'Message', timestamp: '2026-10-02T00:00:00Z', source: flags & 16 ? 'wake_rule' : 'browser', reactions: [], ...extra }, roomIdentifier: flags & 32 ? 'room' : 'local_room' }
  const app = createSSRApp({ setup() {
    pins.provideRoomMessagePins({ canPin: ref(Boolean(flags & 2)), state: ref({ pending: extra.pinPending ? 'msg_12' : null }), isPinned: () => false, toggle() {} })
    reactions.provideRoomMessageReactions({ canReact: ref(Boolean(flags & 4)), reactionsFor: () => [], viewerReacted: () => false, track: () => () => {}, toggle() {} })
    provide(unreadMenuKey, { client: { account: ref(flags & 8 ? 'person' : null), mark() {} }, room: ref('room') })
    return () => h(OpenChat, props)
  } })
  const context: any = {}
  await renderToString(app, context)
  const html = context.teleports?.body ?? ''
  const rows = [...html.matchAll(/<button([^>]*role="menuitem"[^>]*)>([\s\S]*?)<\/button>/g)].map(match => {
    const row = new AuditElement(match[2].replace(/<[^>]+>/g, '').trim())
    row.disabled = /\bdisabled\b/.test(match[1]); return row
  })
  vm.contextMenuRef.value = markRaw({ querySelectorAll: (selector: string) => rows.filter(row => !selector.includes(':not(:disabled)') || !row.disabled), querySelector: () => rows[0] })
  return { vm, rows, invoker, target, doc, win }
}
test('integrated web menu renders ordered rows for all 64 configurations and preserves the native link menu', async t => {
  for (let flags = 0; flags < 64; flags++) await t.test(String(flags), async t => {
    const { vm, rows, invoker } = await webMenuAudit(t, flags)
    const expected = flags & 1 ? [] : ['Copy message', ...(flags & 32 ? ['Copy link to message'] : []),
      ...(flags & 16 ? [] : ['Reply']), ...(flags & 2 ? ['Pin message'] : []),
      ...(flags & 4 && !(flags & 16) ? ['Add reaction…'] : []), ...(flags & 8 ? ['Mark unread from here'] : []), 'Message info']
    assert.deepEqual(rows.map(row => row.label), expected)
    if (!rows.length) { assert.equal(vm.contextMenuOpen.value, false); return }
    assert.ok(vm.contextMenuPosition.value.y + rows.length * 34 + 21 <= 600)
    for (let i = 0; i < rows.length; i++) {
      rows[i].focus(); vm.handleMenuKeydown({ key: 'ArrowDown', preventDefault() {} }); assert.equal(document.activeElement, rows[(i + 1) % rows.length])
      vm.handleMenuKeydown({ key: 'ArrowUp', preventDefault() {} }); assert.equal(document.activeElement, rows[i])
    }
    vm.handleMenuKeydown({ key: 'Home', preventDefault() {} }); assert.equal(document.activeElement, rows[0])
    vm.handleMenuKeydown({ key: 'End', preventDefault() {} }); assert.equal(document.activeElement, rows.at(-1))
    vm.handleMenuDismiss({ type: 'keydown', key: 'Escape' }); assert.equal(document.activeElement, invoker)
  })
})
test('web keyboard navigation skips a pending disabled pin row', async t => {
  const { vm, rows } = await webMenuAudit(t, 46, { pinPending: true })
  const disabled = rows.findIndex(row => row.disabled)
  rows[disabled - 1].focus(); vm.handleMenuKeydown({ key: 'ArrowDown', preventDefault() {} })
  assert.equal(document.activeElement, rows[disabled + 1])
})
test('web pin action returns focus to the invoker', async t => {
  const { vm, rows, invoker } = await webMenuAudit(t)
  rows[3].focus(); vm.pinFromMenu(); await nextTick()
  assert.equal(document.activeElement, invoker)
})
test('web menu stays inside a short viewport', async t => {
  const { vm, win, target } = await webMenuAudit(t)
  win.innerHeight = 250
  vm.openContextMenu({ target, clientX: 799, clientY: 249, preventDefault() {} })
  await nextTick()
  assert.ok(vm.contextMenuPosition.value.y >= 8)
})

test('web copy and unread restore focus; outside dismissal preserves the new target', async t => {
  for (const action of ['copyMessageFromMenu', 'copyMessageLinkFromMenu', 'markUnreadFromMenu', 'outside']) await t.test(action, async t => {
    const { vm, rows, invoker } = await webMenuAudit(t)
    rows[0].focus()
    if (action === 'outside') vm.handleMenuDismiss({ type: 'blur' })
    else await vm[action]()
    await nextTick()
    assert.equal(document.activeElement, action === 'outside' ? rows[0] : invoker)
  })
})
test('web unconfirmed IDs and thread replies suppress inapplicable menu actions', async t => {
  for (const message of [{ id: 'pending:1' }, { thread_root_id: 'msg_1' }]) await t.test(JSON.stringify(message), async t => {
    const { vm } = await webMenuAudit(t, 46, message)
    if ('id' in message) for (const name of ['canCopyMessageLink', 'pinnable', 'reactable', 'canMarkUnread']) assert.equal(vm[name].value, false, name)
    if ('thread_root_id' in message) assert.equal(vm.canMarkUnread.value, false)
  })
})
