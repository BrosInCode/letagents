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

test('the shared indicator escapes names and uses a static, non-interactive absolute overlay', () => {
  const component = read('../../../shared/ui/TypingIndicator.vue')
  assert.match(component, /\{\{ label \}\}/)
  assert.doesNotMatch(component, /v-html|animation|transition|@keyframes/)
  for (const rule of ['position: absolute', 'pointer-events: none', 'white-space: nowrap', 'height: 12px', 'line-height: 12px']) {
    assert.ok(component.includes(rule), rule)
  }
  assert.match(component, /role="status" aria-live="polite" aria-atomic="true"/)
  assert.match(component, /font-size: 11px/)
  assert.match(component, /color: var\(--text-tertiary, var\(--muted\)\)/)
  assert.match(read('../src/components/room/composer/Composer.css'), /\.composer-typing-input \{ position: relative; \}/)
  assert.match(read('../../../apps/desktop/renderer/src/styles/composer-agent-reasoning/composer-controls.css'),
    /\.desktop-composer \.desktop-composer-input-row > \.room-typing-indicator \{ top: -5px;/)
})

test('both clients use the shared expiry scheduler instead of a standing composer interval', () => {
  for (const path of ['../src/composables/roomTyping.ts',
    '../../../apps/desktop/renderer/src/composables/useRoomTyping.ts']) {
    const source = read(path)
    assert.match(source, /createTypingDisplay\(value =>/)
    assert.doesNotMatch(source, /setInterval|clearInterval/)
    assert.match(source, /onScopeDispose\(\(\) => \{ leave\(\)/)
  }
})
