import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
}

const chatMessage = source('../src/components/room/ChatMessage.vue')
const messageMeta = source('../src/components/room/chat-message/MessageMeta.vue')

test('web messages replace the browser context menu with the message menu', () => {
  assert.match(chatMessage, /@contextmenu="openContextMenu"/)
  assert.match(chatMessage, /Copy message<\/button>/)
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
