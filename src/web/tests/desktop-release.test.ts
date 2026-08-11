import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { MAC_DESKTOP_BETA } from '../src/domain/desktopRelease'

test('Mac beta links use public same-origin download routes', () => {
  assert.deepEqual(MAC_DESKTOP_BETA, {
    version: '0.1.2',
    checksumsUrl: '/downloads/mac/v0.1.2/checksums',
    downloads: {
      arm64: '/downloads/mac/arm64',
      x64: '/downloads/mac/x64',
    },
  })
  assert.doesNotMatch(JSON.stringify(MAC_DESKTOP_BETA), /github\.com/)
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
