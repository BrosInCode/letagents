<template>
  <div
    ref="stageEl"
    class="symbiosis-canvas-stage"
    :data-focus="symbiosisBridge.focus"
    aria-hidden="true"
  >
    <canvas ref="canvasEl" class="symbiosis-webgl" />
    <div class="symbiosis-vignette" />
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import * as THREE from 'three'
import { symbiosisBridge, type TopologyModeId } from './symbiosisData'

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
let coreGroup: THREE.Group | null = null
let particleMaterial: THREE.ShaderMaterial | null = null
let coreMaterial: THREE.ShaderMaterial | null = null
let wireMaterial: THREE.ShaderMaterial | null = null
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
let biasCurrent = 0

const PARTICLE_COUNT = 4800

// 4 sculptural chapters driven by scroll or mode pill:
// 0: Dual-Hemisphere Symbiote (Organic left stream + Venom ferrofluid right tendrils)
// 1: Split Duality Theatre (Left human hemisphere vs Right agentic hemisphere)
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

    scaleArray[i] = 0.55 + Math.pow(r1, 3.1) * 2.85
    phaseArray[i] = r2 * Math.PI * 2

    const i3 = i * 3
    const t = i / PARTICLE_COUNT

    // ─── CHAPTER 0: HERO — Half-Organic / Half-Venom Symbiote Tendril Halo ───
    if (i < PARTICLE_COUNT * 0.64) {
      const idx = i / (PARTICLE_COUNT * 0.64)
      const phi = Math.acos(1 - 2 * idx)
      const theta = Math.PI * (1 + Math.sqrt(5)) * i
      const nx = Math.sin(phi) * Math.cos(theta)
      const ny = Math.cos(phi)
      const nz = Math.sin(phi) * Math.sin(theta)

      // Left hemisphere for Human (-x), Right hemisphere with tendril spikes for Agent (+x)
      const hemiX = isAgent ? Math.abs(nx) : -Math.abs(nx)
      const spike = isAgent
        ? Math.pow(Math.abs(Math.sin(theta * 5.0 + phi * 4.0)), 2.2) * 1.15
        : Math.sin(phi * 3.0) * 0.12
      const rad = 1.95 + spike + (r1 - 0.5) * 0.24

      chapters[0][i3] = hemiX * rad * 1.22
      chapters[0][i3 + 1] = ny * rad * 0.96
      chapters[0][i3 + 2] = nz * rad
    } else {
      // Reaching symbiote tendrils on the right, silk aura on the left
      const wt = (i - PARTICLE_COUNT * 0.64) / (PARTICLE_COUNT * 0.36)
      const side = isAgent ? 1 : -1
      const spread = Math.pow(wt, 0.82)
      const tendrilBranch = (i % 7) * 0.9
      chapters[0][i3] = side * (1.8 + spread * 5.6)
      chapters[0][i3 + 1] =
        Math.sin(spread * (isAgent ? 6.5 : 3.2) + tendrilBranch) * (0.55 + spread * 1.15) +
        (r1 - 0.5) * 0.42
      chapters[0][i3 + 2] =
        Math.cos(spread * (isAgent ? 5.2 : 2.8) + tendrilBranch) * (0.65 + spread * 0.9) +
        (r2 - 0.5) * 0.42
    }

    // ─── CHAPTER 1: SYMBIOSIS — Interlocking Venom Tendril Bridge across the Seam ───
    {
      const x = (t - 0.5) * 10.2
      const side = isAgent ? 1.0 : -1.0
      const twist = x * (isAgent ? 1.25 : 0.72) + (isAgent ? Math.PI * 0.65 : 0)
      const envelope = 1.25 * (1.0 - Math.abs(t - 0.5) * 0.65) + (r1 - 0.5) * 0.25
      const tendrilReach = isAgent ? Math.sin(x * 3.4 + r2 * 6.28) * 0.42 : 0
      chapters[1][i3] = x * 0.92 + side * 0.35
      chapters[1][i3 + 1] = Math.sin(twist) * envelope + tendrilReach + (r2 - 0.5) * 0.16
      chapters[1][i3 + 2] = Math.cos(twist) * envelope + (r3 - 0.5) * 0.18
    }

    // ─── CHAPTER 2: LENDING — Sovereign left sphere beaming a bounded arc to right sphere ───
    if (!isAgent && i < PARTICLE_COUNT * 0.44) {
      const idx = i / (PARTICLE_COUNT * 0.44)
      const phi = Math.acos(1 - 2 * (idx % 1))
      const theta = Math.PI * (1 + Math.sqrt(5)) * i
      const rad = 1.38 + (r1 - 0.5) * 0.12
      chapters[2][i3] = -2.45 + rad * Math.sin(phi) * Math.cos(theta)
      chapters[2][i3 + 1] = rad * Math.cos(phi)
      chapters[2][i3 + 2] = rad * Math.sin(phi) * Math.sin(theta)
    } else if (isAgent && i < PARTICLE_COUNT * 0.72) {
      const idx = (i - PARTICLE_COUNT * 0.44) / (PARTICLE_COUNT * 0.28)
      const phi = Math.acos(1 - 2 * Math.abs(idx % 1))
      const theta = Math.PI * (1 + Math.sqrt(5)) * i
      const spike = Math.pow(Math.abs(Math.sin(theta * 4.0)), 2.0) * 0.35
      const rad = 1.18 + spike + (r2 - 0.5) * 0.14
      chapters[2][i3] = 2.45 + rad * Math.sin(phi) * Math.cos(theta)
      chapters[2][i3 + 1] = rad * Math.cos(phi)
      chapters[2][i3 + 2] = rad * Math.sin(phi) * Math.sin(theta)
    } else {
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

// ─── SYMBIOTE CORE SHADER (Left = Warm Organic Human, Right = Ferrofluid Venom Symbiote) ───
const CORE_VERTEX_SHADER = `
  uniform float uTime;
  uniform float uBias;
  uniform float uScroll;
  uniform vec2 uPointer;

  varying vec3 vNormal;
  varying vec3 vWorldPos;
  varying float vSymbiote;
  varying float vSeamGlow;
  varying float vTendrilCrest;

  void main() {
    vec3 pos = position;
    vec3 norm = normalize(normal);

    // Dynamic living seam between Human (left) and Symbiote Agent (right)
    float seamWave =
      sin(pos.y * 3.4 + uTime * 1.35) * 0.22 +
      cos(pos.z * 2.9 - uTime * 1.05) * 0.18 +
      sin((pos.y + pos.z) * 5.2 + uTime * 2.1) * 0.08;

    // uBias = -1 (Human dominates), 0 (50/50 split), +1 (Agent symbiote surges across)
    float seamCenter = -uBias * 0.68 + seamWave;
    float symbiote = smoothstep(seamCenter - 0.32, seamCenter + 0.32, pos.x);
    float seamGlow = exp(-pow((pos.x - seamCenter) * 3.6, 2.0));

    // Left Hemisphere (Human / Organic): smooth, warm, harmonic breathing
    float organicBreath =
      sin(pos.y * 2.2 + uTime * 1.1) * 0.065 +
      cos(pos.x * 2.0 - uTime * 0.85) * 0.05;

    // Right Hemisphere (Agent / Venom Symbiote): ferrofluid spikes & writhing tendrils
    float g1 = sin(pos.x * 6.2 + uTime * 2.2) * cos(pos.y * 6.2 - uTime * 1.8) * sin(pos.z * 6.2 + uTime * 1.5);
    float g2 = sin((pos.x * 9.5 - pos.y * 8.2) + uTime * 3.1) * cos(pos.z * 8.8 - uTime * 2.4);
    float ridge = pow(abs(g1), 1.35) * 0.34 + max(0.0, g2) * 0.22;

    // Tendrils reach outward along the seam and right hemisphere
    float surgeBoost = 1.0 + max(0.0, uBias) * 0.45 + sin(uScroll * 3.14159) * 0.25;
    float displacement = mix(organicBreath, ridge * surgeBoost, symbiote) + seamGlow * 0.14 * sin(pos.y * 8.0 + uTime * 3.2);

    pos += norm * displacement;

    // Subtle magnetic pull toward pointer
    pos.xy += uPointer * 0.16 * (0.4 + symbiote * 0.6);

    vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mvPos;

    vNormal = normalize(normalMatrix * norm);
    vWorldPos = pos;
    vSymbiote = symbiote;
    vSeamGlow = seamGlow;
    vTendrilCrest = clamp(ridge * 2.4, 0.0, 1.0);
  }
`

const CORE_FRAGMENT_SHADER = `
  varying vec3 vNormal;
  varying vec3 vWorldPos;
  varying float vSymbiote;
  varying float vSeamGlow;
  varying float vTendrilCrest;

  void main() {
    vec3 viewDir = vec3(0.0, 0.0, 1.0);
    float fresnel = pow(1.0 - abs(dot(normalize(vNormal), viewDir)), 2.2);

    // Human Organic side: warm alabaster ivory with softliving subsurface warmth
    vec3 humanCore = vec3(0.95, 0.94, 0.92);
    vec3 humanRim = vec3(1.0, 0.89, 0.82);
    vec3 humanCol = mix(humanCore * 0.28, humanRim, fresnel * 0.85);

    // Agent Venom Symbiote side: liquid obsidian chrome veined with bioluminescent mint (#2ac49f)
    vec3 obsidianBase = vec3(0.03, 0.06, 0.055);
    vec3 symbioteMint = vec3(0.165, 0.769, 0.624);
    vec3 symbioteElectric = vec3(0.68, 0.99, 0.89);
    float veinIntensity = clamp(fresnel * 1.15 + vTendrilCrest * 0.85, 0.0, 1.0);
    vec3 agentCol = mix(obsidianBase, symbioteMint, veinIntensity);
    agentCol = mix(agentCol, symbioteElectric, pow(vTendrilCrest, 2.2) * 0.65);

    // Fuse both halves across the living symbiotic seam
    vec3 col = mix(humanCol, agentCol, vSymbiote);
    vec3 seamLight = mix(vec3(1.0, 0.96, 0.92), symbioteElectric, vSymbiote);
    col += seamLight * vSeamGlow * 0.65;

    float alpha = mix(0.18 + fresnel * 0.34, 0.26 + veinIntensity * 0.42, vSymbiote) + vSeamGlow * 0.28;
    gl_FragColor = vec4(col, clamp(alpha, 0.0, 0.76));
  }
`

// ─── CYBERNETIC EXOSKELETON WIREFRAME SHADER (Strictly masks to the Agentic Right Hemisphere) ───
const WIRE_VERTEX_SHADER = `
  uniform float uTime;
  uniform float uBias;
  varying float vMask;
  varying float vPulse;

  void main() {
    vec3 pos = position;
    float seamCenter = -uBias * 0.68 + sin(pos.y * 3.0 + uTime * 1.3) * 0.18;
    vMask = smoothstep(seamCenter - 0.15, seamCenter + 0.45, pos.x);
    vPulse = 0.5 + 0.5 * sin(pos.y * 4.5 - pos.x * 3.2 + uTime * 2.8);

    float spike = sin(pos.x * 5.0 + uTime * 2.0) * cos(pos.y * 5.0 - uTime * 1.6) * 0.12 * vMask;
    pos += normalize(normal) * spike;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`

const WIRE_FRAGMENT_SHADER = `
  varying float vMask;
  varying float vPulse;

  void main() {
    if (vMask < 0.05) discard;
    vec3 mint = vec3(0.165, 0.769, 0.624);
    vec3 bright = vec3(0.78, 1.0, 0.93);
    vec3 col = mix(mint, bright, vPulse * 0.6);
    gl_FragColor = vec4(col, vMask * (0.09 + vPulse * 0.14));
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

    // Organic silk drift on Human particles (0.0), writhing ferrofluid tendril motion on Agent particles (1.0)
    float t = uTime * (0.7 + aSpecies * 0.55);
    float amp = 0.06 + aSpecies * 0.055;
    pos.x += sin(t + aPhase + pos.y * (0.5 + aSpecies * 1.1)) * amp;
    pos.y += cos(t * 1.15 + aPhase + pos.x * (0.4 + aSpecies * 0.9)) * amp;
    pos.z += sin(t * 0.95 + aPhase) * amp;

    // Shift and surge particles when focusing Human (-1) vs Agent (+1)
    pos.x += -uBias * 0.35;

    // Gentle magnetic response to cursor
    vec2 cursorWorld = uPointer * vec2(4.2, 2.5);
    float dist = length(pos.xy - cursorWorld);
    float influence = smoothstep(2.9, 0.0, dist);
    pos.xy += normalize(pos.xy - cursorWorld + vec2(0.0001)) * influence * (-0.16 - aSpecies * 0.12);
    pos.z += influence * 0.34;

    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    float depth = clamp((-mvPosition.z - 3.5) / 11.0, 0.0, 1.0);
    float focusBoost = aSpecies > 0.5
      ? (1.0 + max(0.0, uBias) * 0.35)
      : (1.0 + max(0.0, -uBias) * 0.35);

    gl_PointSize = aScale * focusBoost * (22.0 / -mvPosition.z);

    vSpecies = aSpecies;
    float focusAlpha = aSpecies > 0.5
      ? (1.0 - max(0.0, -uBias) * 0.35)
      : (1.0 - max(0.0, uBias) * 0.35);

    vAlpha = (1.0 - depth * 0.62) * (0.58 + 0.34 * sin(uTime * 1.4 + aPhase)) * focusAlpha;
  }
`

const FRAGMENT_SHADER = `
  varying float vSpecies;
  varying float vAlpha;

  void main() {
    vec2 uv = gl_PointCoord - vec2(0.5);
    float d = length(uv);
    if (d > 0.5) discard;

    float glow = exp(-d * d * 15.0);
    float core = smoothstep(0.22, 0.0, d);

    // Human: Warm Organic Pearl (#F7F4F0)
    // Agent: Bioluminescent Symbiote Mint (#2AC49F)
    vec3 humanColor = vec3(0.97, 0.95, 0.93);
    vec3 agentMint = vec3(0.165, 0.769, 0.624);
    vec3 agentColor = mix(agentMint, vec3(0.92, 1.0, 0.97), core * 0.75);

    vec3 col = mix(humanColor, agentColor, vSpecies);
    gl_FragColor = vec4(col, glow * vAlpha * 0.86);
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

  // 1. Central Dual-Hemisphere Symbiote Core (Organic Left + Venom Ferrofluid Right)
  coreGroup = new THREE.Group()
  rootGroup.add(coreGroup)

  const coreGeo = new THREE.IcosahedronGeometry(1.58, 24)
  coreMaterial = new THREE.ShaderMaterial({
    vertexShader: CORE_VERTEX_SHADER,
    fragmentShader: CORE_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uBias: { value: 0 },
      uScroll: { value: 0 },
      uPointer: { value: new THREE.Vector2(0, 0) },
    },
  })
  const coreMesh = new THREE.Mesh(coreGeo, coreMaterial)
  coreGroup.add(coreMesh)

  // 2. Agentic Geodesic Exoskeleton on the Right Hemisphere
  const wireGeo = new THREE.IcosahedronGeometry(1.72, 8)
  wireMaterial = new THREE.ShaderMaterial({
    vertexShader: WIRE_VERTEX_SHADER,
    fragmentShader: WIRE_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    wireframe: true,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uBias: { value: 0 },
    },
  })
  const wireMesh = new THREE.Mesh(wireGeo, wireMaterial)
  coreGroup.add(wireMesh)

  // 3. Surrounding 4,800 Dual-Species Particle Field
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
      uBias: { value: 0 },
      uPointer: { value: new THREE.Vector2(0, 0) },
    },
  })

  const points = new THREE.Points(geo, particleMaterial)
  rootGroup.add(points)

  // 4. Subtle orbital meridian ring
  const ringSegments = 120
  const ringVerts = new Float32Array(ringSegments * 6)
  for (let i = 0; i < ringSegments; i++) {
    const a1 = (i / ringSegments) * Math.PI * 2
    const a2 = ((i + 1) / ringSegments) * Math.PI * 2
    const r = 2.68
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
  if (!renderer || !scene || !camera || !rootGroup || !coreGroup || !particleMaterial || !coreMaterial || !wireMaterial) return

  scrollCurrent += (scrollTarget - scrollCurrent) * 0.065
  manualModeOffset += (manualModeTarget - manualModeOffset) * 0.065
  biasCurrent += (symbiosisBridge.biasTarget - biasCurrent) * 0.065

  const heroWeight = Math.max(0, 1 - scrollCurrent * 2.2)
  const stageValue = scrollCurrent * 3.0 * (1 - heroWeight) + manualModeOffset * heroWeight
  updateChapterBuffers(stageValue)

  pointerCurrentX += (pointerTargetX - pointerCurrentX) * 0.05
  pointerCurrentY += (pointerTargetY - pointerCurrentY) * 0.05

  const t = prefersReducedMotion ? 0 : nowSec

  particleMaterial.uniforms.uTime.value = t
  particleMaterial.uniforms.uBias.value = biasCurrent
  particleMaterial.uniforms.uPointer.value.set(pointerCurrentX, pointerCurrentY)

  coreMaterial.uniforms.uTime.value = t
  coreMaterial.uniforms.uBias.value = biasCurrent
  coreMaterial.uniforms.uScroll.value = scrollCurrent
  coreMaterial.uniforms.uPointer.value.set(pointerCurrentX, pointerCurrentY)

  wireMaterial.uniforms.uTime.value = t
  wireMaterial.uniforms.uBias.value = biasCurrent

  // Keep the dual-hemisphere split readable while gently tilting with scroll & pointer
  const gentleOscillation = prefersReducedMotion ? 0 : Math.sin(nowSec * 0.35) * 0.14
  coreGroup.rotation.y = gentleOscillation + pointerCurrentX * 0.28 - biasCurrent * 0.26
  coreGroup.rotation.x = pointerCurrentY * -0.16 + Math.sin(scrollCurrent * Math.PI) * 0.14
  coreGroup.position.x = -biasCurrent * 0.65

  const baseSpin = prefersReducedMotion ? 0 : nowSec * 0.045
  rootGroup.rotation.y = baseSpin + pointerCurrentX * 0.14 + scrollCurrent * 0.42
  rootGroup.rotation.x = pointerCurrentY * -0.1 + Math.sin(scrollCurrent * Math.PI) * 0.15

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
  symbiosisBridge.activeChapter = Math.min(5, Math.floor(scrollTarget * 6))
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
  coreMaterial?.dispose()
  wireMaterial?.dispose()
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
  opacity: 0.84;
  transition: opacity 400ms ease;
}

.symbiosis-vignette {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(circle at 50% 44%, rgba(10, 10, 10, 0.22) 0%, rgba(10, 10, 10, 0.76) 68%, #0a0a0a 100%);
}

@media (prefers-reduced-motion: reduce) {
  .symbiosis-webgl {
    opacity: 0.45;
  }
}
</style>
