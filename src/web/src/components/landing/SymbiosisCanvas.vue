<template>
  <div
    ref="stageEl"
    class="symbiosis-canvas-stage"
    :data-focus="symbiosisBridge.focus"
    :data-theme-mode="theme"
    aria-hidden="true"
  >
    <canvas ref="canvasEl" class="symbiosis-webgl" :class="{ 'symbiosis-webgl--unavailable': unavailable }" />
    <div v-if="unavailable" class="symbiosis-fallback" />
    <div class="symbiosis-vignette symbiosis-vignette--dark" />
    <div class="symbiosis-vignette symbiosis-vignette--light" />
  </div>
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import * as THREE from 'three'
import { symbiosisBridge, type TopologyModeId, type SiteTheme } from './symbiosisData'

const props = withDefaults(
  defineProps<{
    mode?: TopologyModeId
    theme?: SiteTheme
  }>(),
  {
    mode: 'symbiosis',
    theme: 'dark',
  },
)

const stageEl = ref<HTMLDivElement | null>(null)
const canvasEl = ref<HTMLCanvasElement | null>(null)
const unavailable = ref(false)

let renderer: THREE.WebGLRenderer | null = null
let scene: THREE.Scene | null = null
let camera: THREE.PerspectiveCamera | null = null
let rootGroup: THREE.Group | null = null
let coreGroup: THREE.Group | null = null
let particleMaterial: THREE.ShaderMaterial | null = null
let coreMaterial: THREE.ShaderMaterial | null = null
let ringLines: THREE.LineSegments | null = null
let posAttrA: THREE.BufferAttribute | null = null
let posAttrB: THREE.BufferAttribute | null = null

let rafId: number | null = null
let resizeObserver: ResizeObserver | null = null
let intersectionObserver: IntersectionObserver | null = null
let motionMedia: MediaQueryList | null = null

let compactMedia: MediaQueryList | null = null
let pointerMedia: MediaQueryList | null = null
let isInViewport = true
let prefersReducedMotion = false
let isCompact = false
let hasFinePointer = false
let trackingPointer = false
let lastDrawMs = 0
let animationTime = 0
let canvasWidth = 0
let canvasHeight = 0
let pixelRatio = 0
const FRAME_INTERVAL_MS = 1000 / 30

function isStaticMode() {
  return prefersReducedMotion || isCompact || !hasFinePointer
}

function canAnimate() {
  return renderer !== null && !unavailable.value && isInViewport && !document.hidden && !isStaticMode()
}

let pointerTargetX = 0
let pointerTargetY = 0
let pointerCurrentX = 0
let pointerCurrentY = 0

let scrollTarget = 0
let scrollCurrent = 0
let manualModeOffset = 0
let manualModeTarget = 0
let biasCurrent = 0
let lightModeTarget = 0
let lightModeCurrent = 0

const PARTICLE_COUNT = 4200

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

    scaleArray[i] = 0.5 + Math.pow(r1, 3.2) * 2.4
    phaseArray[i] = r2 * Math.PI * 2

    const i3 = i * 3
    const t = i / PARTICLE_COUNT

    // ─── CHAPTER 0: HERO — Wide orbital ring leaving the center dark & legible for text ───
    if (i < PARTICLE_COUNT * 0.65) {
      const u = t * Math.PI * 2 * 6
      const strandOffset = isAgent ? Math.PI : 0
      const majorR = 2.65 + (r3 - 0.5) * 0.38
      const minorR = 0.48 + (r1 - 0.5) * 0.16
      const rRing = majorR + minorR * Math.cos(3 * u + strandOffset)
      chapters[0][i3] = rRing * Math.cos(2 * u) * 1.32
      chapters[0][i3 + 1] = rRing * Math.sin(2 * u) * 0.82
      chapters[0][i3 + 2] = minorR * Math.sin(3 * u + strandOffset) * 1.5
    } else {
      const wt = (i - PARTICLE_COUNT * 0.65) / (PARTICLE_COUNT * 0.35)
      const side = isAgent ? 1 : -1
      const spread = Math.pow(wt, 0.85)
      chapters[0][i3] = side * (2.4 + spread * 5.6)
      chapters[0][i3 + 1] =
        Math.sin(spread * 4.2 + (isAgent ? 1.2 : 0)) * (0.6 + spread * 0.85) + (r1 - 0.5) * 0.45
      chapters[0][i3 + 2] =
        Math.cos(spread * 3.4) * (0.65 + spread * 0.75) + (r2 - 0.5) * 0.45
    }

    // ─── CHAPTER 1: SYMBIOSIS — Flowing dual-stream ribbon ───
    {
      const x = (t - 0.5) * 10.5
      const twist = x * 0.8 + (isAgent ? Math.PI : 0)
      const radius = 1.25 * (1.0 - Math.abs(t - 0.5) * 0.7) + (r1 - 0.5) * 0.22
      chapters[1][i3] = x
      chapters[1][i3 + 1] = Math.sin(twist) * radius + (r2 - 0.5) * 0.16
      chapters[1][i3 + 2] = Math.cos(twist) * radius + (r3 - 0.5) * 0.16
    }

    // ─── CHAPTER 2: LENDING — Sovereign left sphere beaming a bounded arc to right sphere ───
    if (!isAgent && i < PARTICLE_COUNT * 0.44) {
      const idx = i / (PARTICLE_COUNT * 0.44)
      const phi = Math.acos(1 - 2 * (idx % 1))
      const theta = Math.PI * (1 + Math.sqrt(5)) * i
      const rad = 1.38 + (r1 - 0.5) * 0.12
      chapters[2][i3] = -2.55 + rad * Math.sin(phi) * Math.cos(theta)
      chapters[2][i3 + 1] = rad * Math.cos(phi)
      chapters[2][i3 + 2] = rad * Math.sin(phi) * Math.sin(theta)
    } else if (isAgent && i < PARTICLE_COUNT * 0.72) {
      const idx = (i - PARTICLE_COUNT * 0.44) / (PARTICLE_COUNT * 0.28)
      const phi = Math.acos(1 - 2 * Math.abs(idx % 1))
      const theta = Math.PI * (1 + Math.sqrt(5)) * i
      const rad = 1.18 + (r2 - 0.5) * 0.14
      chapters[2][i3] = 2.55 + rad * Math.sin(phi) * Math.cos(theta)
      chapters[2][i3 + 1] = rad * Math.cos(phi)
      chapters[2][i3 + 2] = rad * Math.sin(phi) * Math.sin(theta)
    } else {
      const bt = (i - PARTICLE_COUNT * 0.72) / (PARTICLE_COUNT * 0.28)
      const bx = (bt - 0.5) * 5.1
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

// ─── SILKY RIM-LIT SYMBIOTE CORE SHADER (Dark interior so text is 100% readable; organic left + liquid symbiote right rim) ───
const CORE_VERTEX_SHADER = `
  uniform float uTime;
  uniform float uBias;
  uniform float uScroll;
  uniform vec2 uPointer;

  varying vec3 vNormal;
  varying float vSymbiote;
  varying float vSeamGlow;
  varying float vTendrilCrest;

  void main() {
    vec3 pos = position;
    vec3 norm = normalize(position);

    float seamWave =
      sin(pos.y * 2.8 + uTime * 1.1) * 0.2 +
      cos(pos.z * 2.4 - uTime * 0.9) * 0.16;

    float seamCenter = -uBias * 0.55 + seamWave;
    float symbiote = smoothstep(seamCenter - 0.45, seamCenter + 0.45, pos.x);
    float seamGlow = exp(-pow((pos.x - seamCenter) * 3.0, 2.0));

    // Left Hemisphere (Human / Organic): smooth, calm breathing
    float organicBreath =
      sin(pos.y * 2.0 + uTime * 0.9) * 0.055 +
      cos(pos.x * 1.8 - uTime * 0.7) * 0.045;

    // Right Hemisphere (Agent / Liquid Symbiote): smooth ferrofluid waves (no jagged low-poly spikes)
    float w1 = sin(pos.x * 3.8 + uTime * 1.6) * cos(pos.y * 3.8 - uTime * 1.3) * sin(pos.z * 3.6 + uTime * 1.1);
    float w2 = sin((pos.x * 5.2 - pos.y * 4.8) + uTime * 2.1) * 0.5;
    float liquidWave = (w1 * 0.22 + w2 * 0.09) * (1.0 + max(0.0, uBias) * 0.35);

    float displacement = mix(organicBreath, liquidWave, symbiote);
    pos += norm * displacement;

    // Recalculate smooth normal from displaced sphere radial direction
    vec3 smoothNorm = normalize(pos);

    vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mvPos;

    vNormal = normalize(normalMatrix * smoothNorm);
    vSymbiote = symbiote;
    vSeamGlow = seamGlow;
    vTendrilCrest = clamp(abs(w1) * 1.6, 0.0, 1.0);
  }
`

const CORE_FRAGMENT_SHADER = `
  uniform float uScroll;
  uniform float uLightMode;
  varying vec3 vNormal;
  varying float vSymbiote;
  varying float vSeamGlow;
  varying float vTendrilCrest;

  void main() {
    vec3 viewDir = vec3(0.0, 0.0, 1.0);
    float ndotv = abs(dot(normalize(vNormal), viewDir));

    // Luminous Fresnel rim + soft subsurface glow so the symbiote orb glows vividly behind frosted glass
    float rim = pow(1.0 - ndotv, 2.15);
    float subsurface = pow(1.0 - ndotv, 1.1) * 0.28;

    // Dark Mode Palette: warm pearl ivory human side + electric emerald-mint agent side
    vec3 darkHuman = vec3(0.97, 0.96, 0.94);
    vec3 darkAgent = mix(vec3(0.165, 0.78, 0.63), vec3(0.74, 1.0, 0.91), vTendrilCrest * 0.65);
    vec3 darkSeam = vec3(0.86, 1.0, 0.95);

    // Light Mode Palette: sculpted graphite-obsidian human side + vibrant emerald-jade agent side
    vec3 lightHuman = vec3(0.14, 0.15, 0.19);
    vec3 lightAgent = mix(vec3(0.04, 0.62, 0.49), vec3(0.16, 0.84, 0.68), vTendrilCrest * 0.65);
    vec3 lightSeam = vec3(0.08, 0.76, 0.60);

    vec3 humanCol = mix(darkHuman, lightHuman, uLightMode);
    vec3 agentCol = mix(darkAgent, lightAgent, uLightMode);
    vec3 seamHot = mix(darkSeam, lightSeam, uLightMode);

    vec3 col = mix(humanCol, agentCol, vSymbiote);
    col = mix(col, seamHot, vSeamGlow * 0.45);

    float alpha = rim * 0.74 + subsurface + vSeamGlow * 0.36 + vTendrilCrest * vSymbiote * 0.22;
    float maxAlpha = mix(0.84, 0.66, uLightMode);

    gl_FragColor = vec4(col, clamp(alpha, 0.0, maxAlpha));
  }
`

// ─── PARTICLE FIELD SHADER ───
const VERTEX_SHADER = `
  uniform float uTime;
  uniform float uBlend;
  uniform float uBias;
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

    float t = uTime * (0.65 + aSpecies * 0.35);
    float amp = 0.055 + aSpecies * 0.035;
    pos.x += sin(t + aPhase + pos.y * 0.5) * amp;
    pos.y += cos(t * 1.1 + aPhase + pos.x * 0.4) * amp;
    pos.z += sin(t * 0.9 + aPhase) * amp;

    // Gentle magnetic response to cursor
    vec2 cursorWorld = uPointer * vec2(4.0, 2.4);
    float dist = length(pos.xy - cursorWorld);
    float influence = smoothstep(2.6, 0.0, dist);
    pos.xy += normalize(pos.xy - cursorWorld + vec2(0.0001)) * influence * -0.15;
    pos.z += influence * 0.28;

    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    float depth = clamp((-mvPosition.z - 3.5) / 11.0, 0.0, 1.0);
    gl_PointSize = aScale * (21.0 / -mvPosition.z);

    vSpecies = aSpecies;
    float focusAlpha = aSpecies > 0.5
      ? (1.0 - max(0.0, -uBias) * 0.25)
      : (1.0 - max(0.0, uBias) * 0.25);

    vAlpha = (1.0 - depth * 0.65) * (0.55 + 0.32 * sin(uTime * 1.3 + aPhase)) * focusAlpha;
  }
`

const FRAGMENT_SHADER = `
  uniform float uLightMode;
  varying float vSpecies;
  varying float vAlpha;

  void main() {
    vec2 uv = gl_PointCoord - vec2(0.5);
    float d = length(uv);
    if (d > 0.5) discard;

    float glow = exp(-d * d * 15.0);
    float core = smoothstep(0.22, 0.0, d);

    vec3 darkHuman = vec3(0.96, 0.96, 0.98);
    vec3 darkAgent = mix(vec3(0.165, 0.769, 0.624), vec3(0.92, 1.0, 0.97), core * 0.72);

    vec3 lightHuman = vec3(0.16, 0.17, 0.22);
    vec3 lightAgent = mix(vec3(0.04, 0.62, 0.48), vec3(0.14, 0.80, 0.64), core * 0.55);

    vec3 humanColor = mix(darkHuman, lightHuman, uLightMode);
    vec3 agentColor = mix(darkAgent, lightAgent, uLightMode);

    vec3 col = mix(humanColor, agentColor, vSpecies);
    gl_FragColor = vec4(col, glow * vAlpha * mix(0.82, 0.68, uLightMode));
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
  const width = Math.max(rect.width, 1)
  const height = Math.max(rect.height, 1)

  camera = new THREE.PerspectiveCamera(38, width / height, 0.1, 60)
  camera.position.set(0, 0, 9.8)

  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: 'default',
    })
  } catch {
    unavailable.value = true
    return
  }

  resizeScene(width, height)
  renderer.setClearColor(0x000000, 0)

  rootGroup = new THREE.Group()
  scene.add(rootGroup)

  // 1. High-resolution Silky Rim-Lit Symbiote Core
  coreGroup = new THREE.Group()
  rootGroup.add(coreGroup)

  const coreGeo = new THREE.IcosahedronGeometry(1.75, isStaticMode() ? 18 : 36)
  coreMaterial = new THREE.ShaderMaterial({
    vertexShader: CORE_VERTEX_SHADER,
    fragmentShader: CORE_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    uniforms: {
      uTime: { value: 0 },
      uBias: { value: 0 },
      uScroll: { value: 0 },
      uLightMode: { value: lightModeCurrent },
      uPointer: { value: new THREE.Vector2(0, 0) },
    },
  })
  const coreMesh = new THREE.Mesh(coreGeo, coreMaterial)
  coreGroup.add(coreMesh)

  // 2. Surrounding Dual-Species Particle Field
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
    blending: THREE.NormalBlending,
    uniforms: {
      uTime: { value: 0 },
      uBlend: { value: 0 },
      uBias: { value: 0 },
      uLightMode: { value: lightModeCurrent },
      uPointer: { value: new THREE.Vector2(0, 0) },
    },
  })

  const points = new THREE.Points(geo, particleMaterial)
  rootGroup.add(points)

  // 3. Whisper-thin orbital ring
  const ringSegments = 120
  const ringVerts = new Float32Array(ringSegments * 6)
  for (let i = 0; i < ringSegments; i++) {
    const a1 = (i / ringSegments) * Math.PI * 2
    const a2 = ((i + 1) / ringSegments) * Math.PI * 2
    const r = 2.75
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
    color: 0x86868b,
    transparent: true,
    opacity: 0.08,
  })
  ringLines = new THREE.LineSegments(ringGeo, ringMat)
  rootGroup.add(ringLines)

  updateChapterBuffers(0)
  renderFrame(0, true)
}

watch(
  () => props.mode,
  (mode) => {
    manualModeTarget = mode === 'symbiosis' ? 0 : mode === 'lending' ? 2 : 3
    if (!canAnimate()) drawStillFrame()
  },
)

watch(
  () => props.theme,
  (theme) => {
    lightModeTarget = theme === 'light' ? 1 : 0
    if (!canAnimate()) drawStillFrame()
  },
)

watch(() => symbiosisBridge.biasTarget, () => {
  if (isInViewport && !isCompact && hasFinePointer && !canAnimate()) drawStillFrame()
})

function drawStillFrame() {
  if (!document.hidden) renderFrame(animationTime, true)
}

function renderFrame(nowSec: number, snap = false) {
  if (!renderer || !scene || !camera || !rootGroup || !coreGroup || !particleMaterial || !coreMaterial) return

  const still = isStaticMode()
  const immediate = snap || still
  const centered = isCompact || !hasFinePointer
  const targetBias = centered ? 0 : symbiosisBridge.biasTarget
  scrollCurrent += ((still ? 0 : scrollTarget) - scrollCurrent) * (immediate ? 1 : 0.06)
  manualModeOffset += (manualModeTarget - manualModeOffset) * (immediate ? 1 : 0.06)
  biasCurrent += (targetBias - biasCurrent) * (immediate ? 1 : 0.055)
  lightModeCurrent += (lightModeTarget - lightModeCurrent) * (immediate ? 1 : 0.09)

  const heroWeight = Math.max(0, 1 - scrollCurrent * 2.2)
  const stageValue = scrollCurrent * 3.0 * (1 - heroWeight) + manualModeOffset * heroWeight
  updateChapterBuffers(stageValue)

  pointerCurrentX += ((still ? 0 : pointerTargetX) - pointerCurrentX) * (immediate ? 1 : 0.045)
  pointerCurrentY += ((still ? 0 : pointerTargetY) - pointerCurrentY) * (immediate ? 1 : 0.045)

  const t = still ? 0 : nowSec

  particleMaterial.uniforms.uTime.value = t
  particleMaterial.uniforms.uBias.value = biasCurrent
  particleMaterial.uniforms.uLightMode.value = lightModeCurrent
  particleMaterial.uniforms.uPointer.value.set(pointerCurrentX, pointerCurrentY)

  coreMaterial.uniforms.uTime.value = t
  coreMaterial.uniforms.uBias.value = biasCurrent
  coreMaterial.uniforms.uScroll.value = scrollCurrent
  coreMaterial.uniforms.uLightMode.value = lightModeCurrent
  coreMaterial.uniforms.uPointer.value.set(pointerCurrentX, pointerCurrentY)

  // Glide the symbiote core into open negative space opposite the active text column
  const gentleOscillation = still ? 0 : Math.sin(nowSec * 0.32) * 0.12
  coreGroup.rotation.y = gentleOscillation + pointerCurrentX * 0.22 - biasCurrent * 0.35
  coreGroup.rotation.x = pointerCurrentY * -0.14 + Math.sin(scrollCurrent * Math.PI) * 0.12
  coreGroup.position.x = -biasCurrent * 1.75

  const baseSpin = still ? 0 : nowSec * 0.045
  rootGroup.rotation.y = baseSpin + pointerCurrentX * 0.14 + scrollCurrent * 0.45
  rootGroup.rotation.x = pointerCurrentY * -0.1 + Math.sin(scrollCurrent * Math.PI) * 0.14

  renderer.render(scene, camera)
}

function tick(nowMs: number) {
  rafId = null
  if (!canAnimate()) return
  if (lastDrawMs === 0 || nowMs - lastDrawMs >= FRAME_INTERVAL_MS) {
    if (lastDrawMs !== 0) animationTime += Math.min(nowMs - lastDrawMs, 100) * 0.001
    lastDrawMs = nowMs
    renderFrame(animationTime)
  }
  rafId = window.requestAnimationFrame(tick)
}

function syncLoop() {
  const animate = canAnimate()
  if (animate && rafId === null) rafId = window.requestAnimationFrame(tick)
  if (!animate) {
    if (rafId !== null) window.cancelAnimationFrame(rafId)
    rafId = null
    lastDrawMs = 0
  }
  if (animate === trackingPointer) return
  trackingPointer = animate
  if (animate) {
    window.addEventListener('pointermove', onPointerMove, { passive: true })
    window.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
  } else {
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('scroll', onScroll)
    pointerTargetX = pointerTargetY = 0
  }
}

function onPointerMove(e: PointerEvent) {
  if (e.pointerType !== 'mouse' && e.pointerType !== 'pen') return
  const nx = (e.clientX / Math.max(window.innerWidth, 1)) * 2 - 1
  const ny = -((e.clientY / Math.max(window.innerHeight, 1)) * 2 - 1)
  pointerTargetX = Math.max(-1, Math.min(1, nx))
  pointerTargetY = Math.max(-1, Math.min(1, ny))
}

function onScroll() {
  const maxScroll = Math.max(document.documentElement.scrollHeight - window.innerHeight, 1)
  scrollTarget = Math.max(0, Math.min(1, window.scrollY / maxScroll))
}

function resizeScene(width: number, height: number) {
  if (!renderer || !camera) return false
  const dpr = Math.min(window.devicePixelRatio || 1, isStaticMode() ? 1.5 : 2)
  const cameraZ = 9.8 / Math.min(1, Math.max(width / height, 0.25))
  if (width === canvasWidth && height === canvasHeight && dpr === pixelRatio && camera.position.z === cameraZ) return false
  canvasWidth = width
  canvasHeight = height
  pixelRatio = dpr
  camera.aspect = width / height
  // Fit the core into portrait width instead of cropping the right hemisphere.
  camera.position.z = cameraZ
  camera.updateProjectionMatrix()
  renderer.setPixelRatio(dpr)
  renderer.setSize(width, height, false)
  return true
}

function handleResize(entries: ResizeObserverEntry[]) {
  const rect = entries[0]?.contentRect
  if (rect && resizeScene(Math.max(rect.width, 1), Math.max(rect.height, 1))) drawStillFrame()
}

function onPreferencesChange() {
  prefersReducedMotion = motionMedia?.matches ?? false
  isCompact = compactMedia?.matches ?? false
  hasFinePointer = pointerMedia?.matches ?? false
  if (canvasWidth && canvasHeight) resizeScene(canvasWidth, canvasHeight)
  syncLoop()
  drawStillFrame()
}

function onVisibilityChange() {
  syncLoop()
  if (!document.hidden) drawStillFrame()
}

function disposeScene() {
  scene?.traverse((object) => {
    if (!(object instanceof THREE.Mesh || object instanceof THREE.Points || object instanceof THREE.LineSegments)) return
    object.geometry.dispose()
    const materials = Array.isArray(object.material) ? object.material : [object.material]
    for (const material of materials) material.dispose()
  })
  renderer?.dispose()
  renderer = null
  scene = null
}

function onContextLost(event: Event) {
  event.preventDefault()
  unavailable.value = true
  syncLoop()
  disposeScene()
}

onMounted(() => {
  lightModeTarget = props.theme === 'light' ? 1 : 0
  lightModeCurrent = lightModeTarget
  manualModeTarget = props.mode === 'symbiosis' ? 0 : props.mode === 'lending' ? 2 : 3
  motionMedia = window.matchMedia('(prefers-reduced-motion: reduce)')
  compactMedia = window.matchMedia('(max-width: 768px)')
  pointerMedia = window.matchMedia('(hover: hover) and (pointer: fine)')
  prefersReducedMotion = motionMedia.matches
  isCompact = compactMedia.matches
  hasFinePointer = pointerMedia.matches

  try {
    initScene()
  } catch {
    unavailable.value = true
    disposeScene()
  }
  if (!renderer) return

  motionMedia.addEventListener('change', onPreferencesChange)
  compactMedia.addEventListener('change', onPreferencesChange)
  pointerMedia.addEventListener('change', onPreferencesChange)
  canvasEl.value?.addEventListener('webglcontextlost', onContextLost)

  if (stageEl.value && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(handleResize)
    resizeObserver.observe(stageEl.value)
  }

  // The artwork is fixed, so observe its hero rather than the always-visible canvas.
  const hero = stageEl.value?.closest('.hero')
  if (hero && typeof IntersectionObserver !== 'undefined') {
    intersectionObserver = new IntersectionObserver(
      (entries) => {
        isInViewport = entries[0]?.isIntersecting ?? false
        syncLoop()
      },
      { threshold: 0.01 },
    )
    intersectionObserver.observe(hero)
  }
  document.addEventListener('visibilitychange', onVisibilityChange)
  syncLoop()
})

onBeforeUnmount(() => {
  if (rafId !== null) window.cancelAnimationFrame(rafId)
  resizeObserver?.disconnect()
  intersectionObserver?.disconnect()
  motionMedia?.removeEventListener('change', onPreferencesChange)
  compactMedia?.removeEventListener('change', onPreferencesChange)
  pointerMedia?.removeEventListener('change', onPreferencesChange)
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('scroll', onScroll)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  canvasEl.value?.removeEventListener('webglcontextlost', onContextLost)
  disposeScene()
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
  opacity: 0.92;
}

.symbiosis-webgl--unavailable {
  visibility: hidden;
}

.symbiosis-fallback {
  position: absolute;
  top: 50%;
  left: 50%;
  width: min(66vw, 420px);
  aspect-ratio: 1;
  transform: translate(-50%, -50%);
  border-radius: 46% 54% 49% 51%;
  background: radial-gradient(ellipse at 35% 30%, #a4c5ae, #202e27 22%, #111 48%, #57616c 70%, #101417 76%);
  box-shadow: inset -10px -6px 24px #98afab55, 0 0 50px #658c7833;
}

.symbiosis-vignette {
  position: absolute;
  inset: 0;
  transition: opacity 420ms cubic-bezier(0.22, 1, 0.36, 1);
}

.symbiosis-vignette--dark {
  opacity: 1;
  background:
    radial-gradient(circle at 50% 45%, rgba(10, 10, 10, 0.16) 0%, rgba(10, 10, 10, 0.64) 72%, #0a0a0a 100%);
}

.symbiosis-vignette--light {
  opacity: 0;
  background:
    radial-gradient(circle at 50% 45%, rgba(245, 245, 247, 0.14) 0%, rgba(245, 245, 247, 0.66) 72%, #f5f5f7 100%);
}

.symbiosis-canvas-stage[data-theme-mode="light"] .symbiosis-vignette--dark {
  opacity: 0;
}

.symbiosis-canvas-stage[data-theme-mode="light"] .symbiosis-vignette--light {
  opacity: 1;
}

@media (prefers-reduced-motion: reduce) {
  .symbiosis-vignette {
    transition: none;
  }
}
</style>
