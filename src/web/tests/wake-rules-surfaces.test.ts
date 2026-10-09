import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
}

const chatMessage = source('../src/components/room/ChatMessage.vue')
const messageList = source('../src/components/room/MessageList.vue')
const rosterList = source('../src/components/room/activity/ActivityRosterList.vue')
const liveDetail = source('../src/components/room/activity/ActivityLiveDetail.vue')
const activityView = source('../src/components/room/ActivityView.vue')
const tabPanels = source('../src/pages/room/RoomTabPanels.vue')
const roomPage = source('../src/pages/Room.vue')

test('wake notices render as one quiet line with the shared crescent instead of the sender dot', () => {
  assert.match(chatMessage, /import WakeGlyph from '\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/shared\/ui\/WakeGlyph\.vue'/)
  assert.match(chatMessage, /props\.message\.source === WAKE_NOTICE_SOURCE/)
  // A usage-limit notice shares the quiet line with its own glyph (see usage-limit-notice.test.ts).
  assert.match(chatMessage, /<WakeGlyph v-else-if="isWakeNotice" class="wake-notice-glyph" state="woke" :still="!arriving" \/>\s*<div v-else class="message-avatar"/)
  // No meta row, bubble, or reply affordance: the line is the whole message.
  const wakeBody = chatMessage.slice(
    chatMessage.indexOf('<div v-if="isQuietNotice" class="message-body wake-notice-body">'),
    chatMessage.indexOf('<div v-else class="message-body">'),
  )
  assert.ok(wakeBody.length > 0)
  assert.doesNotMatch(wakeBody, /MessageMeta|message-bubble|ReplyPreview|emit\('reply'/)
  assert.match(wakeBody, /<time :datetime="message\.timestamp"/)
  assert.match(chatMessage, /<button v-if="!isQuietNotice" type="button" role="menuitem" @click="replyFromMenu">Reply<\/button>/)
  assert.match(chatMessage, /const isQuietNotice = computed\(\(\) => isWakeNotice\.value \|\| usageLimitNotice\.value !== null\)/)
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
  assert.match(rosterList, /<WakeRuleLine\s+v-if="waitingRules\(participant\)\.length"/)
  assert.match(rosterList, /<template v-else>\s*<span>\{\{ participantNoteText\(participant\) \}\}<\/span>/)
  assert.match(rosterList, /rosterWaitingRules\(participant, props\.mode, props\.wakeRulesByAgentKey\)/)
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
  // The chat reveals the message after its own first scroll to the bottom.
  assert.match(messageList, /scrollToBottom\('instant'\)\s*setupReadObserver\(\)\s*initialScrollSettled = true\s*revealRequestedMessage\(\)/)
  assert.match(messageList, /MAX_REVEAL_OLDER_PAGES = 20/)
})
