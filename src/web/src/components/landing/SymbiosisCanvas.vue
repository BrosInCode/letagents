<template>
  <div
    ref="stageRef"
    class="symbiosis-stage"
    :class="[`symbiosis-stage--${activeMode}`]"
    @pointermove="onPointerMove"
    @pointerleave="onPointerLeave"
    @click="triggerSynapticPulse"
  >
    <canvas
      ref="canvasRef"
      class="symbiosis-canvas"
      aria-label="Interactive 3D visualization of Human and AI Agent symbiosis in a LetAgents room"
    />

    <!-- Projected 3D Node Telemetry Callouts -->
    <div class="node-labels-layer" aria-hidden="true">
      <div
        v-for="tag in projectedTags"
        :key="tag.id"
        class="node-tag"
        :class="[`node-tag--${tag.kind}`, { 'node-tag--visible': tag.visible }]"
        :style="{
          transform: `translate3d(${tag.x}px, ${tag.y}px, 0) scale(${tag.scale})`,
          opacity: tag.opacity,
        }"
      >
        <span class="node-tag-dot" />
        <span class="node-tag-id">{{ tag.label }}</span>
        <span class="node-tag-meta">{{ tag.sub }}</span>
      </div>
    </div>

    <!-- Top-Left Live Protocol Badge -->
    <div class="stage-hud-top">
      <div class="hud-legend">
        <span class="legend-item legend-item--human">
          <span class="legend-swatch" />
          Human Judgment
        </span>
        <span class="legend-sep">×</span>
        <span class="legend-item legend-item--agent">
          <span class="legend-swatch" />
          Agent Velocity
        </span>
      </div>

      <button
        type="button"
        class="hud-pulse-btn"
        title="Dispatch a live MCP protocol pulse across the 3D room lattice"
        @click.stop="triggerSynapticPulse"
      >
        <span class="pulse-indicator" :class="{ 'pulse-indicator--active': pulseActive }" />
        <span>{{ pulseLabel }}</span>
      </button>
    </div>

    <!-- Bottom Interactive Mode Switcher & Live Telemetry -->
    <div class="stage-hud-bottom" @click.stop>
      <div class="mode-switcher" role="tablist" aria-label="3D Topology Modes">
        <button
          v-for="m in modes"
          :key="m.id"
          type="button"
          role="tab"
          :aria-selected="activeMode === m.id"
          class="mode-btn"
          :class="{ 'mode-btn--active': activeMode === m.id }"
          @click="selectMode(m.id)"
        >
          <span class="mode-code">{{ m.code }}</span>
          <span class="mode-label">{{ m.label }}</span>
        </button>
      </div>

      <div class="telemetry-strip">
        <div
          v-for="item in currentModeSpec.telemetry"
          :key="item.key"
          class="telemetry-cell"
          :class="`telemetry-cell--${item.tone}`"
        >
          <span class="telemetry-key">{{ item.key }}</span>
          <span class="telemetry-val">{{ item.value }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import * as THREE from 'three'
import { TOPOLOGY_MODES, type TopologyModeId } from './symbiosisData'

const props = withDefaults(defineProps<{
  modelValue?: TopologyModeId
}>(), {
  modelValue: 'symbiosis',
})

const emit = defineEmits<{
  (e: 'update:modelValue', value: TopologyModeId): void
}>()

const modes = TOPOLOGY_MODES
const activeMode = ref<TopologyModeId>(props.modelValue)

watch(() => props.modelValue, (val) => {
  if (val && val !== activeMode.value) {
    activeMode.value = val
    updateTargetPositions(val)
    triggerSynapticPulse()
  }
})

function selectMode(id: TopologyModeId) {
  activeMode.value = id
  emit('update:modelValue', id)
  updateTargetPositions(id)
  triggerSynapticPulse()
}

const currentModeSpec = computed(() => {
  return modes.find(m => m.id === activeMode.value) ?? modes[0]
})

const stageRef = ref<HTMLElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)

const pulseEvents = [
  'MCP: claim_task("task_108")',
  'CAPTURE: begin_workspace_capture()',
  'RENTAL: lease 400 LRT → active',
  'REVIEW: submit_review_verdict(SHA)',
  'CHECK: letagents-lease ✓ PASSED',
]
const pulseIndex = ref(0)
const pulseActive = ref(false)
const pulseLabel = computed(() => pulseEvents[pulseIndex.value % pulseEvents.length])

interface ProjectedTag {
  id: string
  label: string
  sub: string
  kind: 'human' | 'agent' | 'core'
  anchorIndex: number
  x: number
  y: number
  scale: number
  opacity: number
  visible: boolean
}

const projectedTags = ref<ProjectedTag[]>([
  { id: 'h1', label: '@emmyleke', sub: 'Human Admin · Intent', kind: 'human', anchorIndex: 0, x: 0, y: 0, scale: 1, opacity: 0, visible: false },
  { id: 'a1', label: 'emmyleke/claude-code', sub: 'Claude Opus · Local Daemon', kind: 'agent', anchorIndex: 1, x: 0, y: 0, scale: 1, opacity: 0, visible: false },
  { id: 'a2', label: 'kdof64squares/codex', sub: 'Codex Pro · Lent 400 LRT', kind: 'agent', anchorIndex: 2, x: 0, y: 0, scale: 1, opacity: 0, visible: false },
  { id: 'h2', label: '@kdof64squares', sub: 'Compute Provider', kind: 'human', anchorIndex: 3, x: 0, y: 0, scale: 1, opacity: 0, visible: false },
  { id: 'a3', label: 'alex/antigravity', sub: 'SHA Verdict Reviewer', kind: 'agent', anchorIndex: 4, x: 0, y: 0, scale: 1, opacity: 0, visible: false },
  { id: 'a4', label: 'maya/cursor', sub: 'Branch Worktree Lease', kind: 'agent', anchorIndex: 5, x: 0, y: 0, scale: 1, opacity: 0, visible: false },
])

// Three.js runtime references
let renderer: THREE.WebGLRenderer | null = null
let scene: THREE.Scene | null = null
let camera: THREE.PerspectiveCamera | null = null
let rootGroup: THREE.Group | null = null
let coreShaderMat: THREE.ShaderMaterial | null = null
let outerGateRing: THREE.Mesh | null = null
let innerGateRing: THREE.Mesh | null = null
let particleGeometry: THREE.BufferGeometry | null = null
let bridgeLinesGeometry: THREE.BufferGeometry | null = null
let actorMeshes: THREE.Mesh[] = []

const PARTICLE_COUNT = 1600
const currentPositions = new Float32Array(PARTICLE_COUNT * 3)
const targetPositions = new Float32Array(PARTICLE_COUNT * 3)
const particleColors = new Float32Array(PARTICLE_COUNT * 3)
const particlePhases = new Float32Array(PARTICLE_COUNT)

const ACTOR_COUNT = 12
const actorCurrentPos: THREE.Vector3[] = Array.from({ length: ACTOR_COUNT }, () => new THREE.Vector3())
const actorTargetPos: THREE.Vector3[] = Array.from({ length: ACTOR_COUNT }, () => new THREE.Vector3())

let pointerX = 0
let pointerY = 0
let targetRotX = 0.18
let targetRotY = -0.25
let pulseEnergy = 0
let animationFrameId: number | null = null
let isIntersecting = true
let prefersReducedMotion = false
let resizeObserver: ResizeObserver | null = null
let intersectionObserver: IntersectionObserver | null = null
let motionQuery: MediaQueryList | null = null
let pulseResetTimer: ReturnType<typeof setTimeout> | null = null

function triggerSynapticPulse() {
  pulseEnergy = 1.35
  pulseIndex.value = (pulseIndex.value + 1) % pulseEvents.length
  pulseActive.value = true
  if (pulseResetTimer) clearTimeout(pulseResetTimer)
  pulseResetTimer = setTimeout(() => {
    pulseActive.value = false
  }, 650)
  if (prefersReducedMotion) {
    renderSingleFrame(performance.now() * 0.001)
  }
}

function onPointerMove(e: PointerEvent) {
  const el = stageRef.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  const nx = ((e.clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1
  const ny = ((e.clientY - rect.top) / Math.max(rect.height, 1)) * 2 - 1
  pointerX = nx
  pointerY = ny
  targetRotY = nx * 0.55
  targetRotX = -ny * 0.35 + 0.14
}

function onPointerLeave() {
  pointerX = 0
  pointerY = 0
  targetRotY = -0.25
  targetRotX = 0.18
}

function computeSymbiosisPosition(i: number, total: number): [number, number, number] {
  const isHuman = i % 2 === 0
  const t = (i / total) * Math.PI * 8
  const majorR = 2.55 + Math.sin(t * 0.5) * 0.35
  const minorR = 0.82
  const strandOffset = isHuman ? 0 : Math.PI
  const u = t * 0.25
  const v = t * 1.5 + strandOffset

  const x = (majorR + minorR * Math.cos(v)) * Math.cos(u)
  const y = minorR * Math.sin(v) * 1.35 + Math.sin(u * 2) * 0.32
  const z = (majorR + minorR * Math.cos(v)) * Math.sin(u)
  return [x, y, z]
}

function computeLendingPosition(i: number, total: number): [number, number, number] {
  const norm = i / total
  if (norm < 0.36) {
    // Provider Host cluster (Left hemisphere — warm amber & teal)
    const idx = norm / 0.36
    const phi = Math.acos(1 - 2 * idx)
    const theta = Math.PI * (1 + Math.sqrt(5)) * i
    const r = 1.45
    return [
      -2.65 + r * Math.sin(phi) * Math.cos(theta) * 0.85,
      r * Math.sin(phi) * Math.sin(theta),
      r * Math.cos(phi),
    ]
  } else if (norm < 0.64) {
    // Collimated LRT Compute Lease Conduit through the central Handoff Gate
    const streamT = (norm - 0.36) / 0.28
    const lane = i % 6
    const angle = (lane / 6) * Math.PI * 2 + streamT * Math.PI * 4
    const tubeR = 0.28 + Math.sin(streamT * Math.PI) * 0.36
    const x = (streamT - 0.5) * 5.2
    const y = Math.cos(angle) * tubeR
    const z = Math.sin(angle) * tubeR
    return [x, y, z]
  } else {
    // Renter Room cluster (Right hemisphere — active swarm execution)
    const idx = (norm - 0.64) / 0.36
    const phi = Math.acos(1 - 2 * idx)
    const theta = Math.PI * (1 + Math.sqrt(5)) * i
    const r = 1.65
    return [
      2.65 + r * Math.sin(phi) * Math.cos(theta) * 0.85,
      r * Math.sin(phi) * Math.sin(theta),
      r * Math.cos(phi),
    ]
  }
}

function computeSwarmPosition(i: number, total: number): [number, number, number] {
  const ringIdx = i % 4
  const ringProgress = (i / total) * Math.PI * 2 * 3
  const radii = [1.45, 2.35, 3.15, 3.85]
  const tilts = [0.22, -0.48, 0.62, -0.28]
  const r = radii[ringIdx]
  const tilt = tilts[ringIdx]

  const bx = Math.cos(ringProgress) * r
  const bz = Math.sin(ringProgress) * r
  const by = Math.sin(ringProgress * 3 + ringIdx) * 0.28

  // Rotate around Z/X for orbital focus rooms
  const y = by * Math.cos(tilt) - bz * Math.sin(tilt)
  const z = by * Math.sin(tilt) + bz * Math.cos(tilt)
  return [bx, y, z]
}

function updateTargetPositions(mode: TopologyModeId) {
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    let pos: [number, number, number]
    if (mode === 'symbiosis') {
      pos = computeSymbiosisPosition(i, PARTICLE_COUNT)
    } else if (mode === 'lending') {
      pos = computeLendingPosition(i, PARTICLE_COUNT)
    } else {
      pos = computeSwarmPosition(i, PARTICLE_COUNT)
    }
    const i3 = i * 3
    targetPositions[i3] = pos[0]
    targetPositions[i3 + 1] = pos[1]
    targetPositions[i3 + 2] = pos[2]
  }

  // Update 12 distinct actor nodes
  for (let a = 0; a < ACTOR_COUNT; a++) {
    const sampleIdx = Math.floor((a / ACTOR_COUNT) * PARTICLE_COUNT)
    let pos: [number, number, number]
    if (mode === 'symbiosis') {
      const angle = (a / ACTOR_COUNT) * Math.PI * 2
      const isHuman = a % 2 === 0
      const radius = isHuman ? 2.35 : 3.05
      const y = isHuman ? Math.sin(angle * 2) * 0.95 : -Math.sin(angle * 2) * 1.05
      pos = [Math.cos(angle) * radius, y, Math.sin(angle) * radius]
    } else if (mode === 'lending') {
      const isProviderSide = a < 6
      const subAngle = ((a % 6) / 6) * Math.PI * 2
      const xBase = isProviderSide ? -2.55 : 2.55
      pos = [
        xBase + Math.cos(subAngle) * 0.65,
        Math.sin(subAngle) * 1.25,
        Math.cos(subAngle * 2) * 1.1,
      ]
    } else {
      pos = computeSwarmPosition(sampleIdx, PARTICLE_COUNT)
    }
    actorTargetPos[a].set(pos[0], pos[1], pos[2])
  }
}

function initThreeScene() {
  const canvas = canvasRef.value
  const stage = stageRef.value
  if (!canvas || !stage) return

  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    })
  } catch {
    // Graceful fallback in headless or WebGL-disabled environments
    return
  }

  renderer.setClearColor(0x000000, 0)
  scene = new THREE.Scene()
  scene.fog = new THREE.FogExp2(0x08090c, 0.068)

  const width = Math.max(stage.clientWidth, 320)
  const height = Math.max(stage.clientHeight, 320)
  camera = new THREE.PerspectiveCamera(46, width / height, 0.1, 100)
  camera.position.set(0, 0.35, 8.2)

  rootGroup = new THREE.Group()
  scene.add(rootGroup)

  // Lights
  const ambient = new THREE.AmbientLight(0xf4f1ea, 0.7)
  scene.add(ambient)

  const humanLight = new THREE.PointLight(0xf59e0b, 3.2, 16, 1.5)
  humanLight.position.set(-3.5, 2.4, 3.2)
  scene.add(humanLight)

  const agentLight = new THREE.PointLight(0x2ac49f, 3.6, 16, 1.5)
  agentLight.position.set(3.5, -2.0, 3.2)
  scene.add(agentLight)

  // 1. Central Symbiotic Singularity Core (Custom GLSL Shader)
  const coreGeo = new THREE.IcosahedronGeometry(0.92, 5)
  coreShaderMat = new THREE.ShaderMaterial({
    transparent: true,
    uniforms: {
      uTime: { value: 0 },
      uPulse: { value: 0 },
      uMode: { value: 0 },
      uColorHuman: { value: new THREE.Color('#f59e0b') },
      uColorAgent: { value: new THREE.Color('#2ac49f') },
      uColorIvory: { value: new THREE.Color('#f4f1ea') },
    },
    vertexShader: `
      uniform float uTime;
      uniform float uPulse;
      varying vec3 vNormal;
      varying vec3 vPosition;
      varying float vDisplacement;

      void main() {
        vNormal = normalize(normalMatrix * normal);
        float wave1 = sin(position.x * 3.4 + uTime * 1.8) * cos(position.y * 3.1 - uTime * 1.4);
        float wave2 = sin(position.z * 4.2 + uTime * 2.2) * 0.5;
        float disp = (wave1 + wave2) * (0.065 + uPulse * 0.08);
        vDisplacement = disp;
        vec3 newPos = position + normal * disp;
        vPosition = (modelViewMatrix * vec4(newPos, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(newPos, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform float uPulse;
      uniform vec3 uColorHuman;
      uniform vec3 uColorAgent;
      uniform vec3 uColorIvory;
      varying vec3 vNormal;
      varying vec3 vPosition;
      varying float vDisplacement;

      void main() {
        vec3 viewDir = normalize(-vPosition);
        float fresnel = pow(1.0 - max(dot(viewDir, normalize(vNormal)), 0.0), 2.4);
        float mixFactor = smoothstep(-0.12, 0.12, vDisplacement + sin(uTime + vNormal.x * 2.0) * 0.05);
        vec3 baseColor = mix(uColorHuman, uColorAgent, mixFactor);
        vec3 finalColor = mix(baseColor * 0.38, uColorIvory, fresnel * (0.75 + uPulse * 0.35));
        finalColor += uColorAgent * fresnel * 0.55;
        float alpha = 0.72 + fresnel * 0.28;
        gl_FragColor = vec4(finalColor, alpha);
      }
    `,
  })
  const coreMesh = new THREE.Mesh(coreGeo, coreShaderMat)
  rootGroup.add(coreMesh)

  // Architectural Open-Room Portal Rings around the Core
  const outerRingGeo = new THREE.TorusGeometry(1.38, 0.022, 16, 96, Math.PI * 1.72)
  const outerRingMat = new THREE.MeshBasicMaterial({
    color: 0xf4f1ea,
    transparent: true,
    opacity: 0.45,
  })
  outerGateRing = new THREE.Mesh(outerRingGeo, outerRingMat)
  rootGroup.add(outerGateRing)

  const innerRingGeo = new THREE.TorusGeometry(1.68, 0.018, 16, 96, Math.PI * 1.45)
  const innerRingMat = new THREE.MeshBasicMaterial({
    color: 0x2ac49f,
    transparent: true,
    opacity: 0.55,
  })
  innerGateRing = new THREE.Mesh(innerRingGeo, innerRingMat)
  innerGateRing.rotation.x = Math.PI * 0.35
  rootGroup.add(innerGateRing)

  // 2. Dual-Species Particle Field (Humans = Warm Amber/Ivory, Agents = Brand Teal/Cyan)
  const colorHuman = new THREE.Color('#f59e0b')
  const colorIvory = new THREE.Color('#f4f1ea')
  const colorAgent = new THREE.Color('#2ac49f')
  const colorCyan = new THREE.Color('#38bdf8')

  updateTargetPositions(activeMode.value)

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const i3 = i * 3
    currentPositions[i3] = targetPositions[i3]
    currentPositions[i3 + 1] = targetPositions[i3 + 1]
    currentPositions[i3 + 2] = targetPositions[i3 + 2]
    particlePhases[i] = Math.random() * Math.PI * 2

    const isHuman = i % 2 === 0
    const c = isHuman
      ? colorHuman.clone().lerp(colorIvory, (i % 7) / 10)
      : colorAgent.clone().lerp(colorCyan, (i % 5) / 10)
    particleColors[i3] = c.r
    particleColors[i3 + 1] = c.g
    particleColors[i3 + 2] = c.b
  }

  particleGeometry = new THREE.BufferGeometry()
  particleGeometry.setAttribute('position', new THREE.Float32BufferAttribute(currentPositions, 3))
  particleGeometry.setAttribute('color', new THREE.Float32BufferAttribute(particleColors, 3))

  const particleMaterial = new THREE.PointsMaterial({
    size: 0.055,
    vertexColors: true,
    transparent: true,
    opacity: 0.88,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })

  const particleSystem = new THREE.Points(particleGeometry, particleMaterial)
  rootGroup.add(particleSystem)

  // 3. Sculpted 3D Actor Nodes (Human Spheres & Agent Octahedrons)
  const humanNodeGeo = new THREE.SphereGeometry(0.13, 20, 20)
  const agentNodeGeo = new THREE.OctahedronGeometry(0.15, 0)

  actorMeshes = []
  for (let a = 0; a < ACTOR_COUNT; a++) {
    const isHuman = a % 2 === 0
    const mat = new THREE.MeshStandardMaterial({
      color: isHuman ? 0xfbbf24 : 0x2ac49f,
      emissive: isHuman ? 0xf59e0b : 0x2ac49f,
      emissiveIntensity: 0.75,
      roughness: 0.2,
      metalness: 0.6,
    })
    const mesh = new THREE.Mesh(isHuman ? humanNodeGeo : agentNodeGeo, mat)
    actorCurrentPos[a].copy(actorTargetPos[a])
    mesh.position.copy(actorCurrentPos[a])
    rootGroup.add(mesh)
    actorMeshes.push(mesh)
  }

  // 4. Synaptic Bridge Filaments connecting Human ↔ Agent ↔ Core
  const bridgePositions = new Float32Array(ACTOR_COUNT * 2 * 3 * 2)
  bridgeLinesGeometry = new THREE.BufferGeometry()
  bridgeLinesGeometry.setAttribute('position', new THREE.Float32BufferAttribute(bridgePositions, 3))
  const bridgeMat = new THREE.LineBasicMaterial({
    color: 0x5eead4,
    transparent: true,
    opacity: 0.28,
    blending: THREE.AdditiveBlending,
  })
  const bridgeLines = new THREE.Line(bridgeLinesGeometry, bridgeMat)
  rootGroup.add(bridgeLines)
}

function updateCanvasSize(widthCss: number, heightCss: number, dprWidth?: number, dprHeight?: number) {
  if (!renderer || !camera) return
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const finalW = dprWidth ? Math.round(dprWidth / dpr) : Math.max(widthCss, 1)
  const finalH = dprHeight ? Math.round(dprHeight / dpr) : Math.max(heightCss, 1)
  renderer.setPixelRatio(dpr)
  renderer.setSize(finalW, finalH, false)
  camera.aspect = finalW / finalH
  camera.updateProjectionMatrix()
}

function renderSingleFrame(timeSec: number) {
  if (!renderer || !scene || !camera || !rootGroup) return

  // Smoothly decay pulse energy
  pulseEnergy *= 0.94

  // Smoothly rotate root group toward pointer + orbital drift
  const autoSpin = prefersReducedMotion ? 0 : timeSec * 0.16
  rootGroup.rotation.y += (targetRotY + autoSpin - rootGroup.rotation.y) * 0.06
  rootGroup.rotation.x += (targetRotX - rootGroup.rotation.x) * 0.06

  if (coreShaderMat) {
    coreShaderMat.uniforms.uTime.value = timeSec
    coreShaderMat.uniforms.uPulse.value = pulseEnergy
  }

  if (outerGateRing && innerGateRing) {
    outerGateRing.rotation.z = timeSec * 0.32
    outerGateRing.rotation.y = Math.sin(timeSec * 0.4) * 0.35
    innerGateRing.rotation.z = -timeSec * 0.45
    const ringScale = 1 + pulseEnergy * 0.08
    outerGateRing.scale.set(ringScale, ringScale, ringScale)
  }

  // Morph particle positions toward active topology targets
  if (particleGeometry) {
    const posAttr = particleGeometry.attributes.position
    const arr = posAttr.array as Float32Array
    const lerpSpeed = prefersReducedMotion ? 0.35 : 0.065

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const i3 = i * 3
      const phase = particlePhases[i]
      const breath = prefersReducedMotion ? 0 : Math.sin(timeSec * 1.7 + phase) * (0.04 + pulseEnergy * 0.05)

      arr[i3] += (targetPositions[i3] * (1 + breath) - arr[i3]) * lerpSpeed
      arr[i3 + 1] += (targetPositions[i3 + 1] * (1 + breath) - arr[i3 + 1]) * lerpSpeed
      arr[i3 + 2] += (targetPositions[i3 + 2] * (1 + breath) - arr[i3 + 2]) * lerpSpeed
    }
    posAttr.needsUpdate = true
  }

  // Morph actor nodes & update synaptic bridge lines
  if (bridgeLinesGeometry) {
    const lineAttr = bridgeLinesGeometry.attributes.position
    const lineArr = lineAttr.array as Float32Array
    let ptr = 0

    for (let a = 0; a < ACTOR_COUNT; a++) {
      actorCurrentPos[a].lerp(actorTargetPos[a], prefersReducedMotion ? 0.35 : 0.075)
      const mesh = actorMeshes[a]
      if (mesh) {
        mesh.position.copy(actorCurrentPos[a])
        mesh.rotation.y = timeSec * 0.9 + a
        mesh.rotation.x = timeSec * 0.6 + a
        const s = 1 + pulseEnergy * 0.22
        mesh.scale.set(s, s, s)
      }

      // Segment 1: Actor to Core (0,0,0)
      lineArr[ptr++] = actorCurrentPos[a].x
      lineArr[ptr++] = actorCurrentPos[a].y
      lineArr[ptr++] = actorCurrentPos[a].z
      lineArr[ptr++] = 0
      lineArr[ptr++] = 0
      lineArr[ptr++] = 0

      // Segment 2: Actor to Next Partner Actor (Human ↔ Agent pair)
      const nextA = (a + 1) % ACTOR_COUNT
      lineArr[ptr++] = actorCurrentPos[a].x
      lineArr[ptr++] = actorCurrentPos[a].y
      lineArr[ptr++] = actorCurrentPos[a].z
      lineArr[ptr++] = actorCurrentPos[nextA].x
      lineArr[ptr++] = actorCurrentPos[nextA].y
      lineArr[ptr++] = actorCurrentPos[nextA].z
    }
    lineAttr.needsUpdate = true
  }

  renderer.render(scene, camera)

  // Project 6 primary actor nodes into 2D overlay coordinates for HTML telemetry tags
  const stage = stageRef.value
  if (stage) {
    const w = stage.clientWidth
    const h = stage.clientHeight
    const tempV = new THREE.Vector3()
    rootGroup.updateMatrix()

    for (const tag of projectedTags.value) {
      const node = actorMeshes[tag.anchorIndex]
      if (!node) continue
      tempV.copy(node.position)
      // Apply rootGroup rotation roughly
      const cosY = Math.cos(rootGroup.rotation.y)
      const sinY = Math.sin(rootGroup.rotation.y)
      const rx = tempV.x * cosY + tempV.z * sinY
      const rz = -tempV.x * sinY + tempV.z * cosY
      const ry = tempV.y

      // Perspective projection approximation
      const depth = camera.position.z - rz
      if (depth <= 1.0) {
        tag.visible = false
        continue
      }
      const fovScale = 1 / Math.tan((camera.fov * Math.PI) / 360)
      const ndcX = (rx / (depth * camera.aspect)) * fovScale
      const ndcY = ((ry - camera.position.y * 0.35) / depth) * fovScale

      const screenX = (ndcX * 0.5 + 0.5) * w
      const screenY = (-ndcY * 0.5 + 0.5) * h

      const inBounds = screenX > 56 && screenX < w - 150 && screenY > 56 && screenY < h - 110
      tag.visible = inBounds
      tag.x = Math.round(screenX)
      tag.y = Math.round(screenY)
      const depthFactor = Math.max(0.65, Math.min(1.05, 6.8 / depth))
      tag.scale = Number(depthFactor.toFixed(2))
      tag.opacity = inBounds ? Number(Math.min(0.95, depthFactor * 0.9).toFixed(2)) : 0
    }
  }
}

function animateLoop(nowMs: number) {
  if (!isIntersecting || document.hidden || prefersReducedMotion) {
    animationFrameId = null
    return
  }
  renderSingleFrame(nowMs * 0.001)
  animationFrameId = requestAnimationFrame(animateLoop)
}

function startLoopIfNeeded() {
  if (!renderer) return
  if (prefersReducedMotion) {
    renderSingleFrame(performance.now() * 0.001)
    return
  }
  if (!animationFrameId && isIntersecting && !document.hidden) {
    animationFrameId = requestAnimationFrame(animateLoop)
  }
}

function stopLoop() {
  if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId)
    animationFrameId = null
  }
}

function onVisibilityChange() {
  if (document.hidden) {
    stopLoop()
  } else {
    startLoopIfNeeded()
  }
}

function onMotionPreferenceChange() {
  prefersReducedMotion = Boolean(motionQuery?.matches)
  if (prefersReducedMotion) {
    stopLoop()
    renderSingleFrame(performance.now() * 0.001)
  } else {
    startLoopIfNeeded()
  }
}

onMounted(() => {
  motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
  prefersReducedMotion = motionQuery.matches
  motionQuery.addEventListener('change', onMotionPreferenceChange)

  initThreeScene()

  const stage = stageRef.value
  if (stage && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(([entry]) => {
      if (!entry) return
      const dpc = entry.devicePixelContentBoxSize
      updateCanvasSize(
        entry.contentRect.width,
        entry.contentRect.height,
        dpc ? dpc[0]?.inlineSize : undefined,
        dpc ? dpc[0]?.blockSize : undefined,
      )
      if (prefersReducedMotion) {
        renderSingleFrame(performance.now() * 0.001)
      }
    })
    const supportsDevicePixelBox =
      typeof ResizeObserverEntry !== 'undefined' &&
      'devicePixelContentBoxSize' in ResizeObserverEntry.prototype
    resizeObserver.observe(stage, supportsDevicePixelBox ? { box: 'device-pixel-content-box' } : undefined)
    updateCanvasSize(stage.clientWidth, stage.clientHeight)
  }

  if (stage && typeof IntersectionObserver !== 'undefined') {
    intersectionObserver = new IntersectionObserver(([entry]) => {
      isIntersecting = Boolean(entry?.isIntersecting)
      if (isIntersecting) startLoopIfNeeded()
      else stopLoop()
    }, { threshold: 0.05 })
    intersectionObserver.observe(stage)
  }

  document.addEventListener('visibilitychange', onVisibilityChange)
  renderSingleFrame(0.5)
  startLoopIfNeeded()
})

onUnmounted(() => {
  stopLoop()
  if (pulseResetTimer) clearTimeout(pulseResetTimer)
  resizeObserver?.disconnect()
  intersectionObserver?.disconnect()
  motionQuery?.removeEventListener('change', onMotionPreferenceChange)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  particleGeometry?.dispose()
  bridgeLinesGeometry?.dispose()
  coreShaderMat?.dispose()
  renderer?.dispose()
})
</script>

<style scoped>
.symbiosis-stage {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 540px;
  border-radius: 28px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.11);
  background:
    radial-gradient(circle at 22% 24%, rgba(245, 158, 11, 0.14), transparent 52%),
    radial-gradient(circle at 78% 72%, rgba(42, 196, 159, 0.16), transparent 56%),
    linear-gradient(165deg, #090a0f 0%, #0d1117 52%, #080a0e 100%);
  box-shadow:
    0 28px 80px rgba(0, 0, 0, 0.65),
    inset 0 1px 0 rgba(255, 255, 255, 0.12);
  cursor: grab;
  user-select: none;
  isolation: isolate;
}

.symbiosis-stage:active {
  cursor: grabbing;
}

/* Architectural grid overlay */
.symbiosis-stage::before {
  content: '';
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(to right, rgba(255, 255, 255, 0.025) 1px, transparent 1px),
    linear-gradient(to bottom, rgba(255, 255, 255, 0.025) 1px, transparent 1px);
  background-size: 44px 44px;
  mask-image: radial-gradient(circle at 50% 48%, black 30%, transparent 85%);
  pointer-events: none;
  z-index: 1;
}

.symbiosis-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  z-index: 2;
}

/* Floating Projected 3D Telemetry Callouts */
.node-labels-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 3;
  overflow: hidden;
}

.node-tag {
  position: absolute;
  top: 0;
  left: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  background: rgba(10, 12, 16, 0.78);
  backdrop-filter: blur(10px);
  border: 1px solid rgba(255, 255, 255, 0.12);
  font-family: var(--font-mono);
  font-size: 0.68rem;
  white-space: nowrap;
  transform-origin: center center;
  transition: opacity 220ms ease;
}

.node-tag--human {
  border-color: rgba(245, 158, 11, 0.38);
}

.node-tag--agent {
  border-color: rgba(42, 196, 159, 0.42);
}

.node-tag-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.node-tag--human .node-tag-dot {
  background: #fbbf24;
  box-shadow: 0 0 8px #f59e0b;
}

.node-tag--agent .node-tag-dot {
  background: #2ac49f;
  box-shadow: 0 0 8px #2ac49f;
}

.node-tag-id {
  color: #f8fafc;
  font-weight: 600;
}

.node-tag-meta {
  color: rgba(226, 232, 240, 0.64);
  padding-left: 6px;
  border-left: 1px solid rgba(255, 255, 255, 0.12);
}

/* HUD Top Bar */
.stage-hud-top {
  position: relative;
  z-index: 4;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 18px 22px;
  flex-wrap: wrap;
}

.hud-legend {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 6px 13px;
  border-radius: 999px;
  background: rgba(10, 12, 18, 0.72);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  font-size: 0.74rem;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: #f4f1ea;
}

.legend-swatch {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.legend-item--human .legend-swatch {
  background: #f59e0b;
  box-shadow: 0 0 10px rgba(245, 158, 11, 0.8);
}

.legend-item--agent .legend-swatch {
  background: #2ac49f;
  box-shadow: 0 0 10px rgba(42, 196, 159, 0.8);
}

.legend-sep {
  color: rgba(255, 255, 255, 0.35);
  font-family: var(--font-mono);
}

.hud-pulse-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 13px;
  border-radius: 999px;
  background: rgba(10, 12, 18, 0.75);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(42, 196, 159, 0.32);
  color: #e2e8f0;
  font-family: var(--font-mono);
  font-size: 0.72rem;
  font-weight: 500;
  transition: border-color 180ms ease, transform 180ms ease, background 180ms ease;
}

.hud-pulse-btn:hover {
  border-color: rgba(42, 196, 159, 0.72);
  background: rgba(42, 196, 159, 0.12);
  transform: translateY(-1px);
}

.pulse-indicator {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #2ac49f;
  box-shadow: 0 0 8px #2ac49f;
  transition: transform 200ms ease, background 200ms ease;
}

.pulse-indicator--active {
  background: #fbbf24;
  box-shadow: 0 0 14px #fbbf24;
  transform: scale(1.45);
}

/* HUD Bottom Controls */
.stage-hud-bottom {
  position: absolute;
  left: 18px;
  right: 18px;
  bottom: 18px;
  z-index: 4;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.mode-switcher {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  padding: 6px;
  border-radius: 16px;
  background: rgba(10, 12, 18, 0.82);
  backdrop-filter: blur(16px);
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.mode-btn {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 9px 12px;
  border-radius: 11px;
  text-align: left;
  border: 1px solid transparent;
  background: transparent;
  color: rgba(226, 232, 240, 0.68);
  transition: all 180ms ease;
}

.mode-btn:hover {
  color: #f8fafc;
  background: rgba(255, 255, 255, 0.04);
}

.mode-btn--active {
  color: #ffffff;
  background: linear-gradient(135deg, rgba(245, 158, 11, 0.14), rgba(42, 196, 159, 0.16));
  border-color: rgba(42, 196, 159, 0.45);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.12);
}

.mode-code {
  font-family: var(--font-mono);
  font-size: 0.64rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: #2ac49f;
}

.mode-btn--active .mode-code {
  color: #fbbf24;
}

.mode-label {
  font-size: 0.8rem;
  font-weight: 700;
  line-height: 1.2;
}

.telemetry-strip {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}

.telemetry-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 11px;
  border-radius: 11px;
  background: rgba(10, 12, 18, 0.76);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  min-width: 0;
}

.telemetry-key {
  font-family: var(--font-mono);
  font-size: 0.6rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: rgba(161, 161, 170, 0.85);
}

.telemetry-val {
  font-family: var(--font-mono);
  font-size: 0.71rem;
  font-weight: 700;
  color: #f4f1ea;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.telemetry-cell--human .telemetry-val {
  color: #fde68a;
}

.telemetry-cell--agent .telemetry-val {
  color: #5eead4;
}

@media (max-width: 900px) {
  .symbiosis-stage {
    min-height: 480px;
  }

  .telemetry-strip {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .node-tag-meta {
    display: none;
  }
}

@media (max-width: 600px) {
  .symbiosis-stage {
    min-height: 440px;
    border-radius: 20px;
  }

  .mode-switcher {
    grid-template-columns: 1fr;
  }

  .telemetry-strip {
    display: none;
  }
}
</style>
