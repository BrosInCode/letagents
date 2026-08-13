import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { fetchCurrentMacDesktopBeta, MAC_DESKTOP_BETA } from '../src/domain/desktopRelease'

test('Mac beta fallback uses current same-origin download routes', () => {
  assert.deepEqual(MAC_DESKTOP_BETA, {
    version: '0.1.5',
    checksumsUrl: '/downloads/mac/v0.1.5/checksums',
    downloads: {
      arm64: '/downloads/mac/arm64',
      x64: '/downloads/mac/x64',
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
    },
  })
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
  const routerPath = fileURLToPath(new URL('../src/router.ts', import.meta.url))
  const heroSource = readFileSync(heroPath, 'utf8')
  const routerSource = readFileSync(routerPath, 'utf8')
  assert.match(heroSource, /id="download-mac"/)
  assert.match(heroSource, /scroll-margin-top:\s*92px/)
  assert.match(routerSource, /el:\s*to\.hash,\s*top:\s*92/)
})
