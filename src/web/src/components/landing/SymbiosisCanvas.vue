<template>
  <div
    ref="stageEl"
    class="symbiosis-canvas-stage"
    aria-hidden="true"
  >
    <canvas ref="canvasEl" class="symbiosis-webgl" />
    <div class="symbiosis-vignette" />
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import * as THREE from 'three'
import type { TopologyModeId } from './symbiosisData'

const props = withDefaults(
  defineProps<{
    mode?: TopologyModeId
  }>(),
  {
    mode: 'symbiosis',
  },
)

const stageEl = ref<HTMLDivElement | null>(null)
const canvasEl = ref<HTMLCanvasElement | null>(null)

let renderer: THREE.WebGLRenderer | null = null
let scene: THREE.Scene | null = null
let camera: THREE.PerspectiveCamera | null = null
let rootGroup: THREE.Group | null = null
let particleMaterial: THREE.ShaderMaterial | null = null
let ringLines: THREE.LineSegments | null = null
let posAttrA: THREE.BufferAttribute | null = null
let posAttrB: THREE.BufferAttribute | null = null

let rafId: number | null = null
let resizeObserver: ResizeObserver | null = null
let intersectionObserver: IntersectionObserver | null = null
let motionMedia: MediaQueryList | null = null

let isInViewport = true
let prefersReducedMotion = false

let pointerTargetX = 0
let pointerTargetY = 0
let pointerCurrentX = 0
let pointerCurrentY = 0

let scrollTarget = 0
let scrollCurrent = 0
let manualModeOffset = 0
let manualModeTarget = 0

const PARTICLE_COUNT = 4800

// 4 sculptural chapters driven by scroll or mode pill:
// 0: Symbiosis Fusion (Two hemispheres weaving into a central torus)
// 1: Double Helix Bridge (Human & Agent dialogue)
// 2: Sovereign Compute Lending (Protected core beaming to a satellite node)
// 3: Public Swarm Constellation (Geodesic multi-ring sphere)
const chapters: Float32Array[] = [
  new Float32Array(PARTICLE_COUNT * 3),
  new Float32Array(PARTICLE_COUNT * 3),
  new Float32Array(PARTICLE_COUNT * 3),
  new Float32Array(PARTICLE_COUNT * 3),
]

const speciesArray = new Float32Array(PARTICLE_COUNT)
const scaleArray = new Float32Array(PARTICLE_COUNT)
const phaseArray = new Float32Array(PARTICLE_COUNT)

function hash(n: number): number {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453
  return x - Math.floor(x)
}

function generateSculptures() {
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const isAgent = i % 2 === 1
    speciesArray[i] = isAgent ? 1.0 : 0.0

    const r1 = hash(i * 1.17 + 0.3)
    const r2 = hash(i * 2.63 + 1.9)
    const r3 = hash(i * 4.91 + 5.7)

    // Varied optical bokeh sizes: mostly fine stardust with occasional bright focal stars
    scaleArray[i] = 0.55 + Math.pow(r1, 3.2) * 2.8
    phaseArray[i] = r2 * Math.PI * 2

    const i3 = i * 3
    const t = i / PARTICLE_COUNT

    // ─── CHAPTER 0: HERO — Two streams converging into one luminous ring ───
    if (i < PARTICLE_COUNT * 0.62) {
      const u = t * Math.PI * 2 * 6
      const strandOffset = isAgent ? Math.PI : 0
      const majorR = 2.35 + (r3 - 0.5) * 0.36
      const minorR = 0.52 + (r1 - 0.5) * 0.18
      const rRing = majorR + minorR * Math.cos(3 * u + strandOffset)
      chapters[0][i3] = rRing * Math.cos(2 * u) * 1.28
      chapters[0][i3 + 1] = rRing * Math.sin(2 * u) * 0.78
      chapters[0][i3 + 2] = minorR * Math.sin(3 * u + strandOffset) * 1.6
    } else {
      const wt = (i - PARTICLE_COUNT * 0.62) / (PARTICLE_COUNT * 0.38)
      const side = isAgent ? 1 : -1
      const spread = Math.pow(wt, 0.85)
      chapters[0][i3] = side * (2.0 + spread * 5.8)
      chapters[0][i3 + 1] = Math.sin(spread * 4.5 + (isAgent ? 1.2 : 0)) * (0.65 + spread * 0.9) + (r1 - 0.5) * 0.55
      chapters[0][i3 + 2] = Math.cos(spread * 3.5) * (0.7 + spread * 0.8) + (r2 - 0.5) * 0.55
    }

    // ─── CHAPTER 1: SYMBIOSIS — Interwoven horizontal double-helix wave ───
    {
      const x = (t - 0.5) * 10.5
      const twist = x * 0.85 + (isAgent ? Math.PI : 0)
      const radius = 1.15 * (1.0 - Math.abs(t - 0.5) * 0.75) + (r1 - 0.5) * 0.25
      chapters[1][i3] = x
      chapters[1][i3 + 1] = Math.sin(twist) * radius + (r2 - 0.5) * 0.18
      chapters[1][i3 + 2] = Math.cos(twist) * radius + (r3 - 0.5) * 0.18
    }

    // ─── CHAPTER 2: LENDING — Sovereign left sphere beaming a bounded arc to right sphere ───
    if (!isAgent && i < PARTICLE_COUNT * 0.44) {
      // Left sovereign host sphere
      const idx = i / (PARTICLE_COUNT * 0.44)
      const phi = Math.acos(1 - 2 * (idx % 1))
      const theta = Math.PI * (1 + Math.sqrt(5)) * i
      const rad = 1.35 + (r1 - 0.5) * 0.12
      chapters[2][i3] = -2.45 + rad * Math.sin(phi) * Math.cos(theta)
      chapters[2][i3 + 1] = rad * Math.cos(phi)
      chapters[2][i3 + 2] = rad * Math.sin(phi) * Math.sin(theta)
    } else if (isAgent && i < PARTICLE_COUNT * 0.72) {
      // Right recipient room sphere
      const idx = (i - PARTICLE_COUNT * 0.44) / (PARTICLE_COUNT * 0.28)
      const phi = Math.acos(1 - 2 * Math.abs(idx % 1))
      const theta = Math.PI * (1 + Math.sqrt(5)) * i
      const rad = 1.15 + (r2 - 0.5) * 0.14
      chapters[2][i3] = 2.45 + rad * Math.sin(phi) * Math.cos(theta)
      chapters[2][i3 + 1] = rad * Math.cos(phi)
      chapters[2][i3 + 2] = rad * Math.sin(phi) * Math.sin(theta)
    } else {
      // Graceful arched bridge between the two spheres
      const bt = (i - PARTICLE_COUNT * 0.72) / (PARTICLE_COUNT * 0.28)
      const bx = (bt - 0.5) * 4.9
      const arch = Math.cos((bt - 0.5) * Math.PI) * 1.15
      const lane = (i % 2 === 0 ? 1 : -1) * arch
      chapters[2][i3] = bx
      chapters[2][i3 + 1] = lane * 0.65 + (r1 - 0.5) * 0.16
      chapters[2][i3 + 2] = Math.sin(bt * Math.PI * 2) * 0.55 + (r3 - 0.5) * 0.16
    }

    // ─── CHAPTER 3: SWARM — Synchronized Fibonacci constellation + orbital rings ───
    if (i < PARTICLE_COUNT * 0.68) {
      const idx = i / (PARTICLE_COUNT * 0.68)
      const phi = Math.acos(1 - 2 * idx)
      const theta = Math.PI * (1 + Math.sqrt(5)) * i
      const rad = (isAgent ? 2.85 : 1.95) + (r1 - 0.5) * 0.18
      chapters[3][i3] = rad * Math.sin(phi) * Math.cos(theta) * 1.15
      chapters[3][i3 + 1] = rad * Math.cos(phi) * 0.92
      chapters[3][i3 + 2] = rad * Math.sin(phi) * Math.sin(theta)
    } else {
      const ringA = t * Math.PI * 30
      const ringR = 3.85 + (r2 - 0.5) * 0.35
      chapters[3][i3] = Math.cos(ringA) * ringR * 1.18
      chapters[3][i3 + 1] = Math.sin(ringA) * 0.45 + (r3 - 0.5) * 0.18
      chapters[3][i3 + 2] = Math.sin(ringA) * ringR * 0.82
    }
  }
}

const VERTEX_SHADER = `
  uniform float uTime;
  uniform float uBlend;
  uniform vec2 uPointer;
  attribute vec3 aNextPosition;
  attribute float aSpecies;
  attribute float aScale;
  attribute float aPhase;

  varying float vSpecies;
  varying float vAlpha;

  float smoothBlend(float x) {
    return x * x * (3.0 - 2.0 * x);
  }

  void main() {
    float b = smoothBlend(clamp(uBlend, 0.0, 1.0));
    vec3 pos = mix(position, aNextPosition, b);

    // Weightless fluid breathing
    float t = uTime * 0.75;
    pos.x += sin(t + aPhase + pos.y * 0.5) * 0.06;
    pos.y += cos(t * 1.1 + aPhase + pos.x * 0.4) * 0.07;
    pos.z += sin(t * 0.9 + aPhase) * 0.06;

    // Gentle magnetic response to cursor
    vec2 cursorWorld = uPointer * vec2(4.0, 2.4);
    float dist = length(pos.xy - cursorWorld);
    float influence = smoothstep(2.8, 0.0, dist);
    pos.xy += normalize(pos.xy - cursorWorld + vec2(0.0001)) * influence * -0.18;
    pos.z += influence * 0.32;

    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    float depth = clamp((-mvPosition.z - 3.5) / 11.0, 0.0, 1.0);
    gl_PointSize = aScale * (22.0 / -mvPosition.z);

    vSpecies = aSpecies;
    vAlpha = (1.0 - depth * 0.65) * (0.58 + 0.32 * sin(uTime * 1.3 + aPhase));
  }
`

const FRAGMENT_SHADER = `
  varying float vSpecies;
  varying float vAlpha;

  void main() {
    vec2 uv = gl_PointCoord - vec2(0.5);
    float d = length(uv);
    if (d > 0.5) discard;

    // Optical Gaussian glow falloff for silky Apple-like light points
    float glow = exp(-d * d * 15.0);
    float core = smoothstep(0.22, 0.0, d);

    // Human: Warm Alabaster / Pearl White (#F5F5F7)
    // Agent: LetAgents Brand Mint (#2AC49F) with pure white core
    vec3 humanColor = vec3(0.96, 0.96, 0.98);
    vec3 agentMint = vec3(0.165, 0.769, 0.624);
    vec3 agentColor = mix(agentMint, vec3(0.94, 1.0, 0.98), core * 0.72);

    vec3 col = mix(humanColor, agentColor, vSpecies);
    gl_FragColor = vec4(col, glow * vAlpha * 0.85);
  }
`

let activeChapterPair = -1

function updateChapterBuffers(continuousStage: number) {
  if (!posAttrA || !posAttrB || !particleMaterial) return
  const clamped = Math.max(0, Math.min(2.999, continuousStage))
  const idxA = Math.floor(clamped)
  const idxB = Math.min(3, idxA + 1)
  const frac = clamped - idxA

  if (idxA !== activeChapterPair) {
    ;(posAttrA.array as Float32Array).set(chapters[idxA])
    ;(posAttrB.array as Float32Array).set(chapters[idxB])
    posAttrA.needsUpdate = true
    posAttrB.needsUpdate = true
    activeChapterPair = idxA
  }

  particleMaterial.uniforms.uBlend.value = frac
}

function initScene() {
  const stage = stageEl.value
  const canvas = canvasEl.value
  if (!stage || !canvas) return

  generateSculptures()

  scene = new THREE.Scene()
  const rect = stage.getBoundingClientRect()
  const width = Math.max(rect.width, 320)
  const height = Math.max(rect.height, 360)

  camera = new THREE.PerspectiveCamera(38, width / height, 0.1, 60)
  camera.position.set(0, 0, 9.8)

  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    })
  } catch {
    return
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.setSize(width, height, false)
  renderer.setClearColor(0x000000, 0)

  rootGroup = new THREE.Group()
  scene.add(rootGroup)

  const geo = new THREE.BufferGeometry()
  posAttrA = new THREE.BufferAttribute(new Float32Array(chapters[0]), 3)
  posAttrB = new THREE.BufferAttribute(new Float32Array(chapters[1]), 3)

  geo.setAttribute('position', posAttrA)
  geo.setAttribute('aNextPosition', posAttrB)
  geo.setAttribute('aSpecies', new THREE.BufferAttribute(speciesArray, 1))
  geo.setAttribute('aScale', new THREE.BufferAttribute(scaleArray, 1))
  geo.setAttribute('aPhase', new THREE.BufferAttribute(phaseArray, 1))

  particleMaterial = new THREE.ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uBlend: { value: 0 },
      uPointer: { value: new THREE.Vector2(0, 0) },
    },
  })

  const points = new THREE.Points(geo, particleMaterial)
  rootGroup.add(points)

  // Subtle geometric orbital ring trace
  const ringSegments = 120
  const ringVerts = new Float32Array(ringSegments * 6)
  for (let i = 0; i < ringSegments; i++) {
    const a1 = (i / ringSegments) * Math.PI * 2
    const a2 = ((i + 1) / ringSegments) * Math.PI * 2
    const r = 2.65
    const idx = i * 6
    ringVerts[idx] = Math.cos(a1) * r * 1.25
    ringVerts[idx + 1] = Math.sin(a1) * r * 0.72
    ringVerts[idx + 2] = 0
    ringVerts[idx + 3] = Math.cos(a2) * r * 1.25
    ringVerts[idx + 4] = Math.sin(a2) * r * 0.72
    ringVerts[idx + 5] = 0
  }
  const ringGeo = new THREE.BufferGeometry()
  ringGeo.setAttribute('position', new THREE.BufferAttribute(ringVerts, 3))
  const ringMat = new THREE.LineBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.045,
    blending: THREE.AdditiveBlending,
  })
  ringLines = new THREE.LineSegments(ringGeo, ringMat)
  rootGroup.add(ringLines)

  updateChapterBuffers(0)
  renderFrame(performance.now() * 0.001)
}

watch(
  () => props.mode,
  (mode) => {
    manualModeTarget = mode === 'symbiosis' ? 0 : mode === 'lending' ? 2 : 3
    if (prefersReducedMotion) {
      manualModeOffset = manualModeTarget
      updateChapterBuffers(manualModeOffset)
      renderFrame(performance.now() * 0.001)
    }
  },
)

function renderFrame(nowSec: number) {
  if (!renderer || !scene || !camera || !rootGroup || !particleMaterial) return

  scrollCurrent += (scrollTarget - scrollCurrent) * 0.06
  manualModeOffset += (manualModeTarget - manualModeOffset) * 0.06

  // Blend scroll-driven progression with manual mode selection when near the top
  const heroWeight = Math.max(0, 1 - scrollCurrent * 2.2)
  const stageValue = scrollCurrent * 3.0 * (1 - heroWeight) + manualModeOffset * heroWeight
  updateChapterBuffers(stageValue)

  pointerCurrentX += (pointerTargetX - pointerCurrentX) * 0.045
  pointerCurrentY += (pointerTargetY - pointerCurrentY) * 0.045

  particleMaterial.uniforms.uTime.value = prefersReducedMotion ? 0 : nowSec
  particleMaterial.uniforms.uPointer.value.set(pointerCurrentX, pointerCurrentY)

  const baseSpin = prefersReducedMotion ? 0 : nowSec * 0.065
  rootGroup.rotation.y = baseSpin + pointerCurrentX * 0.18 + scrollCurrent * 0.65
  rootGroup.rotation.x = pointerCurrentY * -0.12 + Math.sin(scrollCurrent * Math.PI) * 0.18

  renderer.render(scene, camera)
}

function tick(nowMs: number) {
  rafId = null
  if (!isInViewport || document.hidden || prefersReducedMotion) return
  renderFrame(nowMs * 0.001)
  rafId = window.requestAnimationFrame(tick)
}

function syncLoop() {
  if (isInViewport && !document.hidden && !prefersReducedMotion) {
    if (rafId === null) {
      rafId = window.requestAnimationFrame(tick)
    }
  } else if (rafId !== null) {
    window.cancelAnimationFrame(rafId)
    rafId = null
  }
}

function onPointerMove(e: PointerEvent) {
  const nx = (e.clientX / Math.max(window.innerWidth, 1)) * 2 - 1
  const ny = -((e.clientY / Math.max(window.innerHeight, 1)) * 2 - 1)
  pointerTargetX = Math.max(-1, Math.min(1, nx))
  pointerTargetY = Math.max(-1, Math.min(1, ny))
}

function onScroll() {
  const maxScroll = Math.max(document.documentElement.scrollHeight - window.innerHeight, 1)
  scrollTarget = Math.max(0, Math.min(1, window.scrollY / maxScroll))
  if (prefersReducedMotion) {
    scrollCurrent = scrollTarget
    renderFrame(performance.now() * 0.001)
  }
}

function handleResize(entries: ResizeObserverEntry[]) {
  const entry = entries[0]
  if (!entry || !renderer || !camera) return
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const cssWidth = Math.max(entry.contentRect.width, 1)
  const cssHeight = Math.max(entry.contentRect.height, 1)

  camera.aspect = cssWidth / cssHeight
  camera.updateProjectionMatrix()
  renderer.setPixelRatio(dpr)
  renderer.setSize(cssWidth, cssHeight, false)
  renderFrame(performance.now() * 0.001)
}

onMounted(() => {
  motionMedia = window.matchMedia('(prefers-reduced-motion: reduce)')
  prefersReducedMotion = motionMedia.matches
  motionMedia.addEventListener('change', (ev) => {
    prefersReducedMotion = ev.matches
    syncLoop()
  })

  initScene()

  if (stageEl.value && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(handleResize)
    resizeObserver.observe(stageEl.value)
  }

  if (stageEl.value && typeof IntersectionObserver !== 'undefined') {
    intersectionObserver = new IntersectionObserver(
      (entries) => {
        isInViewport = entries[0]?.isIntersecting ?? true
        syncLoop()
      },
      { threshold: 0.01 },
    )
    intersectionObserver.observe(stageEl.value)
  }

  window.addEventListener('pointermove', onPointerMove, { passive: true })
  window.addEventListener('scroll', onScroll, { passive: true })
  document.addEventListener('visibilitychange', syncLoop)
  onScroll()
  syncLoop()
})

onUnmounted(() => {
  if (rafId !== null) window.cancelAnimationFrame(rafId)
  resizeObserver?.disconnect()
  intersectionObserver?.disconnect()
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('scroll', onScroll)
  document.removeEventListener('visibilitychange', syncLoop)
  particleMaterial?.dispose()
  ringLines?.geometry.dispose()
  renderer?.dispose()
})
</script>

<style scoped>
.symbiosis-canvas-stage {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  z-index: 0;
  pointer-events: none;
  overflow: hidden;
}

.symbiosis-webgl {
  display: block;
  width: 100%;
  height: 100%;
  opacity: 0.72;
}

.symbiosis-vignette {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(circle at 50% 42%, rgba(10, 10, 10, 0.35) 0%, rgba(10, 10, 10, 0.78) 68%, #0a0a0a 100%);
}

@media (prefers-reduced-motion: reduce) {
  .symbiosis-webgl {
    opacity: 0.45;
  }
}
</style>
