import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createSSRApp, h } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { createServer, type ViteDevServer } from 'vite'

import {
  HANDOFF_OUTPUT_PROFILES,
  RENTAL_PROVIDERS,
  SWARM_LIFECYCLE_STAGES,
  SYMBIOSIS_EXCHANGE_STEPS,
  TOPOLOGY_MODES,
  symbiosisBridge,
  toggleTheme,
} from '../src/components/landing/symbiosisData'
import { NAV_SECTION_LINKS } from '../src/components/layout/navbar/links'

let vite: ViteDevServer

before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true },
  })
})

after(async () => {
  await vite?.close()
})

function readLandingFile(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    'utf8',
  )
}

async function renderComponent(modulePath: string): Promise<string> {
  const Component = (await vite.ssrLoadModule(modulePath)).default
  const app = createSSRApp({
    setup() {
      return () => h(Component)
    },
  })
  app.component('RouterLink', {
    props: ['to'],
    setup(props: { to?: string }, { slots }) {
      return () => h('a', { href: props.to ?? '#' }, slots.default?.())
    },
  })
  return renderToString(app)
}

test('Symbiosis topology modes cover human-agent fusion, compute lending, and public swarms', () => {
  assert.deepEqual(
    TOPOLOGY_MODES.map((mode) => mode.id),
    ['symbiosis', 'lending', 'swarm'],
  )
  for (const mode of TOPOLOGY_MODES) {
    assert.ok(mode.label.length > 5)
    assert.ok(mode.tagline.length > 10)
    assert.ok(mode.description.length > 20)
    assert.equal(mode.telemetry.length, 4)
  }
})

test('Symbiosis exchange steps pair human editorial sovereignty with real MCP wire primitives', () => {
  assert.equal(SYMBIOSIS_EXCHANGE_STEPS.length, 5)
  const toolCalls = SYMBIOSIS_EXCHANGE_STEPS.map((step) => step.agentActor.toolCall)
  assert.ok(toolCalls.some((t) => t.includes('wait_for_messages')))
  assert.ok(toolCalls.some((t) => t.includes('claim_task')))
  assert.ok(toolCalls.some((t) => t.includes('rental_accept')))
  assert.ok(toolCalls.some((t) => t.includes('publish_workspace_capture')))
  assert.ok(toolCalls.some((t) => t.includes('submit_review_verdict')))
})

test('Handoff v1 output profiles and providers match the rental architecture', () => {
  assert.deepEqual(
    HANDOFF_OUTPUT_PROFILES.map((profile) => profile.id),
    ['draft_pr', 'review_comment', 'research_note'],
  )
  for (const profile of HANDOFF_OUTPUT_PROFILES) {
    assert.ok(profile.capabilities.length >= 4)
    assert.ok(profile.denied.length >= 4)
    assert.ok(profile.branchRule.length > 3)
    assert.ok(profile.secretPolicy.length > 5)
  }

  assert.deepEqual(
    RENTAL_PROVIDERS.map((provider) => provider.id),
    ['claude-max', 'codex-pro', 'cursor-agent', 'antigravity-pro'],
  )
})

test('Swarm lifecycle stages mirror the 7 canonical task board statuses', () => {
  assert.deepEqual(
    SWARM_LIFECYCLE_STAGES.map((stage) => stage.status),
    [
      'proposed',
      'accepted',
      'assigned',
      'in_progress',
      'in_review',
      'merged',
      'done',
    ],
  )
})

test('Three.js SymbiosisCanvas implements dual-hemisphere symbiote core, custom GLSL shaders, observer lifecycle, and reduced-motion support', () => {
  const canvasSource = readLandingFile('../src/components/landing/SymbiosisCanvas.vue')
  assert.match(canvasSource, /import \* as THREE from 'three'/)
  assert.match(canvasSource, /new THREE\.WebGLRenderer/)
  assert.match(canvasSource, /new THREE\.IcosahedronGeometry/)
  assert.match(canvasSource, /new THREE\.ShaderMaterial/)
  assert.match(canvasSource, /CORE_VERTEX_SHADER/)
  assert.match(canvasSource, /CORE_FRAGMENT_SHADER/)
  assert.match(canvasSource, /uLightMode/)
  assert.match(canvasSource, /ResizeObserver/)
  assert.match(canvasSource, /IntersectionObserver/)
  assert.match(canvasSource, /prefers-reduced-motion:\s*reduce/)
})

test('Light and dark mode toggle switches reactive theme and coordinates CSS + WebGL transition tokens', () => {
  assert.equal(symbiosisBridge.theme, 'dark')
  const switched = toggleTheme()
  assert.equal(switched, 'light')
  assert.equal(symbiosisBridge.theme, 'light')
  const restored = toggleTheme()
  assert.equal(restored, 'dark')
  assert.equal(symbiosisBridge.theme, 'dark')

  const globalCss = readLandingFile('../src/styles/global.css')
  assert.match(globalCss, /\[data-theme="light"\]/)
  assert.match(globalCss, /--l-glass-bg:/)
  assert.match(globalCss, /html\.theme-transitioning/)
})

test('Landing sections expose fixed-navbar-safe anchors and mount in Landing.vue', () => {
  const landingSource = readLandingFile('../src/pages/Landing.vue')
  assert.match(landingSource, /<HeroSection \/>/)
  assert.match(landingSource, /<SymbiosisSection \/>/)
  assert.match(landingSource, /<SetupSection \/>/)
  assert.match(landingSource, /<ComputeLendingSection \/>/)
  assert.match(landingSource, /<SwarmOrchestrationSection \/>/)
  assert.match(landingSource, /<RoomEntrySection \/>/)
  assert.match(landingSource, /<FeaturesSection \/>/)

  const sectionAnchors: Array<[string, RegExp]> = [
    ['../src/components/landing/HeroSection.vue', /id="download-mac"/],
    ['../src/components/landing/SymbiosisSection.vue', /id="symbiosis"/],
    ['../src/components/landing/SetupSection.vue', /id="setup"/],
    ['../src/components/landing/ComputeLendingSection.vue', /id="lending"/],
    ['../src/components/landing/SwarmOrchestrationSection.vue', /id="swarms"/],
    ['../src/components/landing/RoomEntrySection.vue', /id="start"/],
    ['../src/components/landing/FeaturesSection.vue', /id="features"/],
  ]

  for (const [file, anchorPattern] of sectionAnchors) {
    const source = readLandingFile(file)
    assert.match(source, anchorPattern, `Expected ${file} to contain ${anchorPattern}`)
    assert.match(source, /scroll-margin-top:\s*92px/, `Expected ${file} to clear fixed navbar`)
  }

  assert.deepEqual(
    NAV_SECTION_LINKS.map((link) => link.to),
    [
      '/#symbiosis',
      '/#setup',
      '/#lending',
      '/#swarms',
      '/#download-mac',
    ],
  )
})

test('Landing sections render authentic codebase narratives and dual-hemisphere human/agent copy via Vue SSR without runtime errors', async () => {
  const heroHtml = await renderComponent('/src/components/landing/HeroSection.vue')
  assert.match(heroHtml, /Let Humans and Agents/)
  assert.match(heroHtml, /id="download-mac"/)

  const symbiosisHtml = await renderComponent('/src/components/landing/SymbiosisSection.vue')
  assert.match(symbiosisHtml, /id="symbiosis"/)
  assert.match(symbiosisHtml, /You lead\./)
  assert.match(symbiosisHtml, /They build\./)
  assert.match(symbiosisHtml, /Claude Code/)
  assert.match(symbiosisHtml, /ChatGPT/)

  const setupHtml = await renderComponent('/src/components/landing/SetupSection.vue')
  assert.match(setupHtml, /id="setup"/)
  assert.match(setupHtml, /Claude Code/)
  assert.match(setupHtml, /ChatGPT/)

  const lendingHtml = await renderComponent('/src/components/landing/ComputeLendingSection.vue')
  assert.match(lendingHtml, /id="lending"/)
  assert.match(lendingHtml, /Lend your agent\./)
  assert.match(lendingHtml, /Never your machine\./)

  const swarmsHtml = await renderComponent('/src/components/landing/SwarmOrchestrationSection.vue')
  assert.match(swarmsHtml, /id="swarms"/)
  assert.match(swarmsHtml, /letagents\.chat\//)
  assert.match(swarmsHtml, /BrosInCode\/letagents/)
  assert.match(swarmsHtml, /Every repository/i)

  const featuresHtml = await renderComponent('/src/components/landing/FeaturesSection.vue')
  assert.match(featuresHtml, /id="features"/)
  assert.match(featuresHtml, /Clear ownership\./)
  assert.match(featuresHtml, /Why Humans Love It/)
  assert.match(featuresHtml, /Why Agents Thrive/)
})
