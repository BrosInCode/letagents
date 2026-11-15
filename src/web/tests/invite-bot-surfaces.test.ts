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
  assert.match(drawer, /<InviteBotPanel v-if="room && room\.authenticated" ref="inviteBotPanel" :room="room" \/>/)
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
  assert.match(section, /<InviteBotPicker :model-value="invite\.platform\.value" @update:model-value="pick" \/>/)
  assert.match(section, /<InviteBotMessage :platform="invite\.platform\.value" :code="invite\.created\.value\?\.code \?\? null"/)
  assert.match(section, /data-testid="invite-bot-copy"[\s\S]*?<CopyStateLabel/)
  assert.match(section, /v-if="invite\.created\.value && cancelInvite"/)
})

test('the composer "+" menu opens the drawer at the invite, already open on the bot picker', () => {
  const composer = source('../src/components/room/Composer.vue')
  const room = source('../src/pages/Room.vue')
  const drawer = source('../src/components/room/RoomDrawer.vue')
  const panel = source('../src/components/room/room-drawer/InviteBotPanel.vue')
  const section = source('../../../shared/ui/InviteBotSection.vue')
  assert.match(composer, /v-if="!inlineThread && isSignedIn"[^>]*\s+data-testid="composer-menu-invite-bot" @click="closeAddMenu\(true\); emit\('inviteBot'\)"/)
  assert.match(room, /@inviteBot="openInviteBot"/)
  assert.match(room, /drawerOpen\.value = true\s+await nextTick\(\)\s+roomDrawer\.value\?\.focusInviteBot\(\)/)
  assert.match(drawer, /defineExpose\(\{ focusRequests, focusInviteBot \}\)/)
  assert.match(panel, /section\.value\?\.openSection\(\)/)
  assert.match(panel, /behavior: reduced \? 'auto' : 'smooth'/, 'reduced motion jumps instead of scrolling')
  assert.match(section, /querySelector<HTMLElement>\('\[role="radio"\]\[aria-checked="true"\]'\)\?\.focus/)
})

test('the web invite calls name the room in the path and the bot in the body, never the code', () => {
  const api = source('../src/composables/room/invites.ts')
  assert.match(api, /apiFetch\(`\$\{roomPath\(room\)\}\/invites`, \{\s*method: 'POST',\s*body: JSON\.stringify\(\{ platform \}\),/)
  assert.match(api, /`\$\{roomPath\(room\)\}\/invites\/\$\{encodeURIComponent\(inviteId\)\}\/cancel`/)
  assert.match(api, /reportRoomRefusal: false/)
})
