import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createSSRApp, h } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { createServer, type ViteDevServer } from 'vite'

import { buildDesktopRoomLink, parseDesktopRoomLink } from '../../../shared/room-app-links.mjs'
import { createOpenInDesktop, type OpenInDesktopDeps } from '../src/composables/openInDesktop'

function harness(overrides: Partial<OpenInDesktopDeps> & { platform?: () => 'mac' | 'windows' | 'other' } = {}) {
  const navigated: string[] = []
  let preference: 'always' | null = null
  let dismissed: string[] = []
  const deps: OpenInDesktopDeps = {
    platform: () => 'mac',
    navigate: link => navigated.push(link),
    readPreference: () => preference,
    writePreference: value => { preference = value },
    readDismissed: () => dismissed,
    writeDismissed: ids => { dismissed = ids },
    ...overrides,
  }
  return { ...createOpenInDesktop(deps), navigated, preference: () => preference, dismissed: () => dismissed }
}

test('the offer shows on Mac and Windows browsers only, once per room per session', () => {
  const mac = harness()
  mac.setRoom('design-lounge')
  assert.equal(mac.visible.value, true)
  assert.equal(mac.state.value, 'offer')
  assert.equal(mac.link.value, 'letagents://in/design-lounge')
  mac.dismiss()
  assert.equal(mac.visible.value, false)
  assert.deepEqual(mac.dismissed(), ['design-lounge'])
  mac.setRoom('other-room')
  assert.equal(mac.visible.value, true, 'another room asks again')
  mac.setRoom('design-lounge')
  assert.equal(mac.visible.value, false, 'the closed room stays closed for the session')

  const phone = harness({ platform: () => 'other' })
  phone.setRoom('design-lounge')
  assert.equal(phone.visible.value, false, 'no desktop app on a phone')
  assert.equal(harness({ platform: () => 'windows' }).downloadHref.value, '/#download-mac', 'no Windows installer yet: the landing page')
  assert.equal(mac.downloadHref.value, '/downloads/mac/arm64')
})

test('Open hands the room to the app once and turns the pill into the opening state', () => {
  const open = harness()
  open.setRoom('design-lounge')
  open.open()
  assert.deepEqual(open.navigated, ['letagents://in/design-lounge'])
  assert.equal(open.state.value, 'opening')
  assert.equal(open.preference(), null, 'Open alone remembers nothing')
  open.open()
  assert.equal(open.navigated.length, 2, 'Open again sends the link again')
  open.dismiss()
  assert.equal(open.visible.value, false, 'Stay here closes it for the session')
})

test('Always remembers the choice and opens the app as soon as a room connects', () => {
  const first = harness()
  first.setRoom('design-lounge')
  first.openAlways()
  assert.equal(first.preference(), 'always')
  assert.deepEqual(first.navigated, ['letagents://in/design-lounge'])
  assert.equal(first.state.value, 'opening')

  const later = harness({ readPreference: () => 'always' })
  assert.equal(later.always.value, true)
  later.setRoom('github.com/acme/app')
  assert.deepEqual(later.navigated, ['letagents://in/github.com/acme/app'], 'opened on load')
  assert.equal(later.state.value, 'opening')
  later.setRoom('github.com/acme/app')
  assert.equal(later.navigated.length, 1, 'the same room is not opened twice')
  later.stopAlways()
  assert.equal(later.preference(), null)
  assert.equal(later.visible.value, false, 'and the pill closes for the session')
  later.setRoom('design-lounge')
  assert.equal(later.navigated.length, 1, 'with Always off, a new room only offers')
  assert.equal(later.state.value, 'offer')

  const dismissedFirst = harness({ readPreference: () => 'always', readDismissed: () => ['design-lounge'] })
  dismissedFirst.setRoom('design-lounge')
  assert.deepEqual(dismissedFirst.navigated, [], 'a room closed this session is not opened automatically')
})

test('the desktop link mirrors the web path and reads back', () => {
  assert.equal(buildDesktopRoomLink('design-lounge', 'msg_4'), 'letagents://in/design-lounge?message=msg_4')
  assert.deepEqual(parseDesktopRoomLink('letagents://in/design-lounge?message=msg_4'), { roomIdentifier: 'design-lounge', messageId: 'msg_4' })
  assert.deepEqual(parseDesktopRoomLink('https://letagents.chat/in/github.com/acme/app'), { roomIdentifier: 'github.com/acme/app', messageId: null })
  assert.equal(parseDesktopRoomLink('letagents://ask/abcdefghijklmnopqrstuvwxyz012345'), null)
})

let vite: ViteDevServer
let OpenInDesktopPill: any
before(async () => {
  vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  OpenInDesktopPill = (await vite.ssrLoadModule('/src/components/room/OpenInDesktopPill.vue')).default
})
after(async () => { await vite?.close() })
const render = (props: Record<string, unknown>) => renderToString(createSSRApp({ render: () => h(OpenInDesktopPill, props) }))

test('the pill offers Open, Always and Not now, then says it is opening with a way back', async () => {
  const offer = await render({ state: 'offer', always: false, downloadHref: '/downloads/mac/arm64' })
  assert.match(offer, /Open this room in LetAgents Desktop/)
  assert.match(offer, /data-testid="open-in-desktop-open"[^>]*>Open</)
  assert.match(offer, /data-testid="open-in-desktop-always"[^>]*>Always</)
  assert.match(offer, /aria-label="Not now"/)
  assert.match(offer, /role="status"/, 'a live region, not a dialog')

  const opening = await render({ state: 'opening', always: true, downloadHref: '/downloads/mac/arm64' })
  assert.match(opening, /Opening in LetAgents Desktop…/)
  assert.match(opening, /data-testid="open-in-desktop-again"/)
  assert.match(opening, /href="\/downloads\/mac\/arm64"[^>]*data-testid="open-in-desktop-download"/)
  assert.match(opening, /data-testid="open-in-desktop-stop"[^>]*>Stop opening automatically</)
  assert.match(opening, /data-testid="open-in-desktop-stay"[^>]*>Stay here</)
  assert.doesNotMatch(opening, /aria-label="Not now"/)
  const openingOnce = await render({ state: 'opening', always: false, downloadHref: '/downloads/mac/arm64' })
  assert.doesNotMatch(openingOnce, /Stop opening automatically/, 'nothing to stop when Always is off')
})

test('the room page mounts the pill above the composer, beside the join requests', async () => {
  const page = await readFile(fileURLToPath(new URL('../src/pages/Room.vue', import.meta.url)), 'utf8')
  const slot = /<div class="room-join-request-slot"[\s\S]*?<\/div>\n/.exec(page)?.[0] ?? ''
  assert.match(slot, /<OpenInDesktopPill[\s\S]*v-if="isConnected && openInDesktop\.visible\.value"/)
  assert.match(page, /openInDesktop\.setRoom\(roomIdentifier\)/, 'the offer follows the connected room')
})
