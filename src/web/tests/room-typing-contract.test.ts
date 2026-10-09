import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('typing stays out of prompt insertion and the thread composer', () => {
  for (const path of ['../src/components/room/composer/useComposerPrompts.ts',
    '../../../apps/desktop/renderer/src/components/desktop/content/room-chat/RoomThreadPanel.vue']) {
    assert.doesNotMatch(read(path), /useRoomTyping|TypingIndicator/)
  }
})

test('the shared indicator escapes names, announces a plain sentence and respects reduced motion', () => {
  const component = read('../../../shared/ui/TypingIndicator.vue')
  assert.doesNotMatch(component, /v-html|innerHTML/)
  assert.match(component, /<strong v-if="part\.name">\{\{ part\.text \}\}<\/strong>/)
  // Assistive technology gets the sentence only; the animated row is decoration.
  assert.match(component, /class="room-typing-status" role="status" aria-live="polite" aria-atomic="true">\{\{ label \}\}/)
  assert.match(component, /class="room-typing-clip" aria-hidden="true"/)
  assert.match(component, /\.room-typing-row \{[\s\S]*?pointer-events: none;/)
  assert.match(component, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.room-typing-wave i \{ animation: none;/)
  assert.match(component, /\.room-typing-fold:not\(\.is-in\) \.room-typing-wave i \{ animation-play-state: paused; \}/)
})

test('typing renders in the pinned live strip, outside the scrolling list and outside the composer', () => {
  for (const path of ['../src/components/room/Composer.vue',
    '../../../apps/desktop/renderer/src/components/desktop/content/room-chat/RoomComposer.vue']) {
    assert.doesNotMatch(read(path), /TypingIndicator/)
  }
  for (const [path, list] of [['../src/components/room/MessageList.vue', 'ref="messagesEl"'],
    ['../../../apps/desktop/renderer/src/components/desktop/content/room-chat/RoomMessageViewport.vue', 'ref="messagesElement"']] as const) {
    const template = read(path).split('</template>\n\n<script')[0]
    const strip = template.indexOf('class="room-live-strip"')
    assert.ok(strip > template.indexOf(list), path)
    assert.ok(template.indexOf('<TypingIndicator', strip) > strip, path)
    assert.ok(template.indexOf('class="room-local-agent-work-list"') > strip, 'working agents share the strip')
    // The strip is a sibling of the scroll container, so no list ancestor is still open at that point.
    const before = template.slice(0, template.lastIndexOf('<div', strip))
    const open = (before.match(/<div\b/g) || []).length - (before.match(/<\/div>/g) || []).length
    assert.equal(open, 1, `${path}: only the root is open around the strip`)
  }
})

test('both clients use the shared expiry scheduler instead of a standing composer interval', () => {
  for (const path of ['../src/composables/roomTyping.ts',
    '../../../apps/desktop/renderer/src/composables/useRoomTyping.ts']) {
    const source = read(path)
    assert.match(source, /createTypingDisplay\(\(value: string\) =>/)
    assert.match(source, /export function useRoomTypingNames/)
    assert.doesNotMatch(source, /setInterval|clearInterval/)
    assert.match(source, /onScopeDispose\(\(\) => \{ leave\(\)/)
  }
})
