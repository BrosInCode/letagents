import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { desktopDownloadOffer, detectDesktopVisitorPlatform, fetchCurrentMacDesktopBeta, MAC_DESKTOP_BETA } from '../src/domain/desktopRelease'

test('Mac beta fallback uses current same-origin download routes', () => {
  assert.deepEqual(MAC_DESKTOP_BETA, {
    version: '0.1.5',
    checksumsUrl: '/downloads/mac/v0.1.5/checksums',
    downloads: {
      arm64: '/downloads/mac/arm64',
      x64: '/downloads/mac/x64',
      windows: null,
    },
  })
  assert.doesNotMatch(JSON.stringify(MAC_DESKTOP_BETA), /github\.com/)
})

test('Mac beta presentation advances from the same-origin current-release manifest', async () => {
  const release = await fetchCurrentMacDesktopBeta(async (input) => {
    assert.equal(input, '/downloads/mac/current.json')
    return new Response(JSON.stringify({
      schemaVersion: 1,
      channel: 'beta',
      version: '0.1.5',
      checksumsUrl: 'https://downloads.letagents.chat/desktop/v0.1.5/checksums.txt',
      assets: {
        arm64: {
          fileName: 'LetAgents-0.1.5-darwin-arm64.dmg',
          publicUrl: 'https://downloads.letagents.chat/desktop/v0.1.5/LetAgents-0.1.5-darwin-arm64.dmg',
          bytes: 120,
          sha256: 'a'.repeat(64),
        },
        x64: {
          fileName: 'LetAgents-0.1.5-darwin-x64.dmg',
          publicUrl: 'https://downloads.letagents.chat/desktop/v0.1.5/LetAgents-0.1.5-darwin-x64.dmg',
          bytes: 140,
          sha256: 'b'.repeat(64),
        },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })

  assert.deepEqual(release, {
    version: '0.1.5',
    checksumsUrl: 'https://downloads.letagents.chat/desktop/v0.1.5/checksums.txt',
    downloads: {
      arm64: 'https://downloads.letagents.chat/desktop/v0.1.5/LetAgents-0.1.5-darwin-arm64.dmg',
      x64: 'https://downloads.letagents.chat/desktop/v0.1.5/LetAgents-0.1.5-darwin-x64.dmg',
      windows: null,
    },
  })
})

test('the Windows installer appears beside the DMGs once the current release lists one', async () => {
  const assets = Object.fromEntries(['arm64', 'x64'].map((architecture) => [architecture, {
    fileName: `LetAgents-0.1.131-darwin-${architecture}.dmg`,
    publicUrl: `https://downloads.letagents.chat/desktop/v0.1.131/LetAgents-0.1.131-darwin-${architecture}.dmg`,
    bytes: 120,
    sha256: 'a'.repeat(64),
  }]))
  const release = await fetchCurrentMacDesktopBeta(async () => new Response(JSON.stringify({
    schemaVersion: 1,
    channel: 'beta',
    version: '0.1.131',
    checksumsUrl: 'https://downloads.letagents.chat/desktop/v0.1.131/checksums.txt',
    assets,
    windows: {
      x64: {
        fileName: 'LetAgents-0.1.131-win32-x64-setup.exe',
        publicUrl: 'https://downloads.letagents.chat/desktop/v0.1.131/LetAgents-0.1.131-win32-x64-setup.exe',
        bytes: 160,
        sha256: 'c'.repeat(64),
      },
    },
  }), { status: 200 }))
  assert.equal(release.downloads.windows, 'https://downloads.letagents.chat/desktop/v0.1.131/LetAgents-0.1.131-win32-x64-setup.exe')

  const heroSource = readFileSync(fileURLToPath(new URL('../src/components/landing/HeroSection.vue', import.meta.url)), 'utf8')
  assert.doesNotMatch(heroSource, /SmartScreen/)
})

test('the visitor platform leads the download links, and Windows appears only with an installer', () => {
  const withWindows = { ...MAC_DESKTOP_BETA, downloads: { ...MAC_DESKTOP_BETA.downloads, windows: 'https://downloads.letagents.chat/setup.exe' } }
  const labels = (offer: ReturnType<typeof desktopDownloadOffer>) => [offer.primary.label, ...offer.others.map((link) => link.label)]

  assert.deepEqual(labels(desktopDownloadOffer(withWindows, 'windows')), ['Windows', 'Mac · Apple Silicon', 'Intel Mac'])
  assert.deepEqual(labels(desktopDownloadOffer(withWindows, 'mac')), ['Mac · Apple Silicon', 'Intel Mac', 'Windows'])
  assert.deepEqual(labels(desktopDownloadOffer(withWindows, 'other')), ['Mac · Apple Silicon', 'Intel Mac', 'Windows'])
  assert.deepEqual(labels(desktopDownloadOffer(MAC_DESKTOP_BETA, 'windows')), ['Mac · Apple Silicon', 'Intel Mac'])
})

test('visitor platform detection reads the browser and treats phones as neither desktop', () => {
  assert.equal(detectDesktopVisitorPlatform({ userAgentData: { platform: 'Windows' } }), 'windows')
  assert.equal(detectDesktopVisitorPlatform({ platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }), 'windows')
  assert.equal(detectDesktopVisitorPlatform({ platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }), 'mac')
  assert.equal(detectDesktopVisitorPlatform({ platform: 'iPhone', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' }), 'other')
  assert.equal(detectDesktopVisitorPlatform({ platform: 'Linux armv81', userAgent: 'Mozilla/5.0 (Linux; Android 14)' }), 'other')
  assert.equal(detectDesktopVisitorPlatform({ platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' }), 'other')
  assert.equal(detectDesktopVisitorPlatform(undefined), 'other')
})

test('Mac beta presentation rejects a current manifest older than its bundled fallback', async () => {
  const responseBody = {
    schemaVersion: 1,
    channel: 'beta',
    version: '0.1.4',
    checksumsUrl: 'https://downloads.letagents.chat/desktop/v0.1.4/checksums.txt',
    assets: Object.fromEntries(['arm64', 'x64'].map((architecture) => [architecture, {
      fileName: `LetAgents-0.1.4-darwin-${architecture}.dmg`,
      publicUrl: `https://downloads.letagents.chat/desktop/v0.1.4/LetAgents-0.1.4-darwin-${architecture}.dmg`,
      bytes: 120,
      sha256: 'a'.repeat(64),
    }])),
  }

  await assert.rejects(
    fetchCurrentMacDesktopBeta(async () => new Response(JSON.stringify(responseBody), { status: 200 })),
    /0\.1\.4 is older than 0\.1\.5/,
  )
})

test('Mac beta anchor clears the fixed navigation bar', () => {
  const heroPath = fileURLToPath(new URL('../src/components/landing/HeroSection.vue', import.meta.url))
  const heroSource = readFileSync(heroPath, 'utf8')
  assert.match(heroSource, /id="download-mac"/)
  assert.match(heroSource, /scroll-margin-top:\s*calc\(92px \+ env\(safe-area-inset-top, 0px\)\)/)
})

test('hash navigation clears the measured navbar and respects reduced motion without changing history restoration', async () => {
  const saved = Object.fromEntries(['window', 'document', 'location', 'history'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  let navbarBottom: number | null = 118, reduce = false
  const location = new URL('https://letagents.test/')
  const history = { state: { current: '/', position: 0 }, length: 1, replaceState() {}, pushState() {} }
  const document = {
    createElement: () => ({}),
    querySelector: (selector: string) => selector === '.navbar' && navbarBottom !== null ? { getBoundingClientRect: () => ({ bottom: navbarBottom }) } : null,
    addEventListener() {}, removeEventListener() {},
  }
  const window = { location, history, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: reduce }) }
  for (const [key, value] of Object.entries({ window, document, location, history })) Object.defineProperty(globalThis, key, { configurable: true, value })
  let router: (typeof import('../src/router'))['router'] | undefined
  try {
    router = (await import('../src/router')).router
    const scroll = (hash: string, position: { top: number; left: number } | null = null) => router!.options.scrollBehavior!({ hash } as any, {} as any, position)
    assert.deepEqual(await scroll('#download-mac'), { el: '#download-mac', top: 138, behavior: 'smooth' })
    reduce = true
    assert.deepEqual(await scroll('#setup'), { el: '#setup', top: 138, behavior: 'instant' })
    navbarBottom = 66
    assert.equal((await scroll('#start') as { top: number }).top, 92)
    navbarBottom = null
    assert.equal((await scroll('#overview') as { top: number }).top, 92)
    const restored = { top: 480, left: 0 }
    assert.equal(await scroll('', restored), restored)
    assert.deepEqual(await scroll(''), { top: 0 })
  } finally {
    router?.options.history.destroy()
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
