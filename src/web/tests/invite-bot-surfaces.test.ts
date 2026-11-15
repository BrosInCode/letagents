import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
}

test('the room drawer lets a signed-in member invite a bot with a one-use code through the shared section', () => {
  const drawer = source('../src/components/room/RoomDrawer.vue')
  const panel = source('../src/components/room/room-drawer/InviteBotPanel.vue')
  const section = source('../../../shared/ui/InviteBotSection.vue')
  assert.match(drawer, /import InviteBotPanel from '\.\/room-drawer\/InviteBotPanel\.vue'/)
  assert.match(drawer, /<InviteBotPanel v-if="room && room\.authenticated" :room="room" \/>/)
  // The panel sits right after the share block, so the code and the invitation are read together.
  assert.ok(drawer.indexOf('<SharePanel') < drawer.indexOf('<InviteBotPanel'), 'share first, then the invitation')
  assert.ok(drawer.indexOf('<InviteBotPanel') < drawer.indexOf('<RoomMembersPanel'), 'the invitation before the member list')
  // The panel names this server's connector and makes the code on the server.
  assert.match(panel, /<h2>Invite a bot<\/h2>/)
  assert.match(panel, /:git-room="room\.gitRoom !== null"/)
  assert.match(panel, /git-room-hint="Open an invite room and invite the bot there\."/)
  assert.match(panel, /:create-invite="createInvite"\s+:cancel-invite="cancelInvite"/)
  assert.match(panel, /connectorUrl: inviteBotConnectorUrl\(typeof window !== 'undefined' \? window\.location\.origin : null\)/)
  assert.match(panel, /return createRoomInvite\(props\.room\.identifier, platform\)/)
  // The shared section: what the invite does, the picker, the message with the code, Copy, and Cancel once made.
  assert.match(section, /data-testid="invite-bot-summary"/)
  assert.match(section, /v-for="choice in INVITE_BOT_PLATFORMS"/)
  assert.match(section, /class="invite-bot-code"/)
  assert.match(section, /data-testid="invite-bot-copy"/)
  assert.match(section, /v-if="invite\.created\.value && cancelInvite"/)
})

test('the web invite calls name the room in the path and the bot in the body, never the code', () => {
  const api = source('../src/composables/room/invites.ts')
  assert.match(api, /apiFetch\(`\$\{roomPath\(room\)\}\/invites`, \{\s*method: 'POST',\s*body: JSON\.stringify\(\{ platform \}\),/)
  assert.match(api, /`\$\{roomPath\(room\)\}\/invites\/\$\{encodeURIComponent\(inviteId\)\}\/cancel`/)
  assert.match(api, /reportRoomRefusal: false/)
})
