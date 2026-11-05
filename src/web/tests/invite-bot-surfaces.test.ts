import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
}

test('the room drawer lets a signed-in member invite a bot with one message through the shared section', () => {
  const drawer = source('../src/components/room/RoomDrawer.vue')
  const panel = source('../src/components/room/room-drawer/InviteBotPanel.vue')
  const section = source('../../../shared/ui/InviteBotSection.vue')
  assert.match(drawer, /import InviteBotPanel from '\.\/room-drawer\/InviteBotPanel\.vue'/)
  assert.match(drawer, /<InviteBotPanel v-if="room && room\.authenticated" :room="room" \/>/)
  // The panel sits right after the share block, so the code and the invitation are read together.
  assert.ok(drawer.indexOf('<SharePanel') < drawer.indexOf('<InviteBotPanel'), 'share first, then the invitation')
  assert.ok(drawer.indexOf('<InviteBotPanel') < drawer.indexOf('<RoomMembersPanel'), 'the invitation before the member list that approves the bot')
  // The panel builds the room facts from the web room and this server's origin.
  assert.match(panel, /<h2>Invite a bot<\/h2>/)
  assert.match(panel, /<InviteBotSection :room="inviteRoom" :admin="room\.role === 'admin'" \/>/)
  assert.match(panel, /roomId: props\.room\.identifier,\s*roomName: props\.room\.displayName,\s*gitRoom: props\.room\.gitRoom !== null,\s*connectorUrl: inviteBotConnectorUrl\(typeof window !== 'undefined' \? window\.location\.origin : null\)/)
  // The shared section: one open button, a picker of the four bots, the message, Copy, and the two hints.
  assert.match(section, /data-testid="invite-bot-open"[^>]*>\s*Invite a bot/)
  assert.match(section, /v-for="choice in INVITE_BOT_PLATFORMS"/)
  assert.match(section, /<pre class="invite-bot-text" data-testid="invite-bot-text">\{\{ invite\.message\.value \}\}<\/pre>/)
  assert.match(section, /data-testid="invite-bot-copy"[\s\S]*?\{\{ invite\.copied\.value \? "Copied" : "Copy" \}\}/)
  assert.match(section, /\{\{ INVITE_BOT_HINT \}\}/)
  // Only an admin approves a request, so only an admin is told where ("Requests" is the drawer panel's title).
  assert.match(section, /v-if="admin && !room\.gitRoom"[^>]*>\{\{ INVITE_BOT_APPROVE_HINT \}\}/)
  assert.match(source('../src/components/room/room-drawer/RoomMembersPanel.vue'), /<h2>Requests<\/h2>/)
})
