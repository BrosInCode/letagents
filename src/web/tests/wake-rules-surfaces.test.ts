import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
}

const chatMessage = source('../src/components/room/ChatMessage.vue')
const messageList = source('../src/components/room/MessageList.vue')
const rosterList = source('../src/components/room/activity/ActivityLiveView.vue')
const liveDetail = source('../src/components/room/activity/ActivityLiveDetail.vue')
const activityView = source('../src/components/room/ActivityView.vue')
const tabPanels = source('../src/pages/room/RoomTabPanels.vue')
const roomPage = source('../src/pages/Room.vue')

test('wake notices render as one quiet line with the shared crescent instead of the sender dot', () => {
  assert.match(chatMessage, /import WakeGlyph from '\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/shared\/ui\/WakeGlyph\.vue'/)
  assert.match(chatMessage, /props\.message\.source === WAKE_NOTICE_SOURCE/)
  assert.match(chatMessage, /<WakeGlyph v-if="isWakeNotice" class="wake-notice-glyph" state="woke" :still="!arriving" \/>\s*<ChatAvatar v-else-if="senderRole"[^>]*\/>\s*<div v-else class="message-avatar"/)
  // No meta row, bubble, or reply affordance: the line is the whole message.
  const wakeBody = chatMessage.slice(
    chatMessage.indexOf('<div v-if="isWakeNotice" class="message-body wake-notice-body">'),
    chatMessage.indexOf('<div v-else class="message-body">'),
  )
  assert.ok(wakeBody.length > 0)
  assert.doesNotMatch(wakeBody, /MessageMeta|message-bubble|ReplyPreview|emit\('reply'/)
  assert.match(wakeBody, /<time :datetime="message\.timestamp"/)
  assert.match(chatMessage, /<button v-if="!isWakeNotice" type="button" role="menuitem" @click="replyFromMenu">Reply<\/button>/)
})

test('the crescent only draws in for a notice that arrives while the room is open', () => {
  assert.match(messageList, /:arriving="arrivingMessageIds\.has\(msg\.id\)"/)
  assert.match(chatMessage, /arriving\?: boolean/)
})

test('wake-notice styling stays neutral, readable, and still under reduced motion', () => {
  const styles = chatMessage.slice(chatMessage.indexOf('.message.wake-notice {'))
  assert.match(styles, /\.wake-notice-glyph \{[^}]*color: var\(--text-tertiary/)
  assert.match(styles, /\.wake-notice-line time \{[^}]*font-variant-numeric: tabular-nums/)
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\) \{\s*\.wake-notice-line \{ transition: none; \}/)
})

test('live agent rows show what they wait for through the shared wake-rule line', () => {
  assert.match(rosterList, /<WakeRuleLine\s+v-if="row.state === 'Online'/)
  assert.match(rosterList, /wakeRulesForAgent\(activeWakeRules, byId.get\(row.id\)\?\.agentKey\)/)
  assert.match(rosterList, /<template v-else>\{\{ row.detail \}\}<\/template>/)
})

test('the agent detail shows its wake rules and opens the wake message in the chat', () => {
  assert.match(liveDetail, /<WakeRulesPanel\s+v-if="participant\.kind === 'agent' && participant\.agentKey"\s+:key="participant\.agentKey"/)
  assert.match(liveDetail, /@open-message="emit\('openMessage', \$event\)"/)
  assert.match(activityView, /useRoomWakeRules\(toRef\(props, 'roomIdentifier'\)\)/)
  assert.match(activityView, /@open-message="emit\('openMessage', \$event\)"/)
  assert.match(tabPanels, /@openMessage="openMessageInChat"/)
  assert.match(tabPanels, /:revealMessageId="revealMessageId"/)
  assert.match(tabPanels, /@revealed="handleMessageRevealed"/)
  assert.match(roomPage, /@openChat="handleActiveTabChange\('chat'\)"/)
  // The chat reveals the message after restoring the room reading position.
  assert.match(messageList, /restorePosition\(\)\s*setupReadObserver\(\)\s*initialScrollSettled = true\s*revealRequestedMessage\(\)/)
  assert.match(messageList, /MAX_REVEAL_OLDER_PAGES = 20/)
})

test('the room drawer lets a signed-in person wake their own bot by webhook through the shared form', () => {
  const drawer = source('../src/components/room/RoomDrawer.vue')
  const panel = source('../src/components/room/room-drawer/WakeWebhookPanel.vue')
  const section = source('../../../shared/ui/WakeWebhookSection.vue')
  assert.match(drawer, /import WakeWebhookPanel from '\.\/room-drawer\/WakeWebhookPanel\.vue'/)
  assert.match(drawer, /<WakeWebhookPanel v-if="room && room\.authenticated" :open="open" :room="room" \/>/)
  // The panel shows only for a person who owns an agent here, loads when the drawer opens, and hands the shared section the web transport.
  assert.match(panel, /<div v-if="agents\.length" class="drawer-section drawer-panel wake-webhook-panel"/)
  assert.match(panel, /<h2>Wake a bot by webhook<\/h2>/)
  assert.match(panel, /:api="roomWakeWebhookApi"/)
  assert.match(panel, /if \(open && authenticated\) void load\(\)/)
  assert.match(panel, /watch\(lastWakeRuleInvalidation/)
  // The shared section: one add button, a password field for the key, the secret shown once.
  assert.match(section, /data-testid="wake-webhook-add"[^>]*>\s*Wake a bot by webhook/)
  assert.match(section, /v-model="form\.draft\.bearer"\s+type="password"/)
  assert.match(section, /v-if="form\.revealedSecret\.value"/)
})
