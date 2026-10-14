<template>
  <section
    ref="panelRoot"
    class="biomech-stage"
    aria-label="Half organic nature and half mechanical moving panel"
    @pointermove="onPointerMove"
    @pointerdown="onPointerDown"
    @pointerup="onPointerUp"
    @pointerleave="onPointerLeave"
  >
    <div class="biomech-panel-frame">
      <canvas ref="canvasEl" class="biomech-canvas" />

      <!-- Interactive seam grip on the dividing line -->
      <div
        class="biomech-seam-hit"
        :style="{ left: `${splitRatio * 100}%` }"
        title="Drag to shift balance between Organic and Mechanical"
        @pointerdown.stop="startSeamDrag"
      >
        <div class="biomech-seam-node">
          <span class="seam-node-ring" />
          <span class="seam-node-core" />
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'

const panelRoot = ref<HTMLElement | null>(null)
const canvasEl = ref<HTMLCanvasElement | null>(null)

const splitRatio = ref(0.5)
let targetSplitRatio = 0.5
let isDraggingSeam = false

const pointer = {
  x: 0.5,
  y: 0.5,
  px: 0,
  py: 0,
  vx: 0,
  vy: 0,
  lastPx: 0,
  lastPy: 0,
  active: false,
}

interface GrassBlade {
  layer: number // 0..4 (5 rolling meadow terraces from upper-mid down to foreground)
  xNorm: number
  baseYOffset: number
  height: number
  width: number
  lean: number
  stiffness: number
  phase: number
  hasSeedHead: boolean
  bendVelocity: number
  currentBend: number
}

interface HangingVine {
  xNorm: number
  length: number
  phase: number
  leafCount: number
}

interface Wildflower {
  layer: number
  xNorm: number
  stemHeight: number
  phase: number
  petalCount: number
  kind: 'daisy' | 'goldcup' | 'dandelion' | 'glowbell'
  scale: number
  currentBend: number
  bendVelocity: number
}

interface FernFrond {
  xNorm: number
  baseYOffset: number
  length: number
  angle: number
  side: number
  phase: number
  pinnaeCount: number
  layer: number
}

interface SporeParticle {
  x: number
  y: number
  vx: number
  vy: number
  radius: number
  alpha: number
  phase: number
  warm: boolean
}

interface SeamVine {
  yNorm: number
  reachRight: number
  curveSeed: number
  leafCount: number
}

interface SteamPuff {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  maxLife: number
  size: number
}

const grassBlades: GrassBlade[] = []
const hangingVines: HangingVine[] = []
const wildflowers: Wildflower[] = []
const fernFronds: FernFrond[] = []
const spores: SporeParticle[] = []
const seamVines: SeamVine[] = []
const steamPuffs: SteamPuff[] = []

let rafId = 0
let resizeObserver: ResizeObserver | null = null
let reducedMotion = false
let startTime = 0
let lastFrameTime = 0

let mechPhase = 0
let mechSpeedMultiplier = 1.0

function seededRandom(seed: number): number {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453123
  return x - Math.floor(x)
}

function initEcosystem() {
  grassBlades.length = 0
  hangingVines.length = 0
  wildflowers.length = 0
  fernFronds.length = 0
  spores.length = 0
  seamVines.length = 0

  // 920 multi-segment grass blades distributed across 5 lush rolling meadow terraces
  const countsPerLayer = [170, 190, 200, 190, 170]
  const layerHeights = [82, 112, 148, 192, 248]
  const layerWidths = [2.2, 3.0, 4.0, 5.2, 6.8]

  let seed = 1
  for (let layer = 0; layer < 5; layer++) {
    const count = countsPerLayer[layer]
    for (let i = 0; i < count; i++) {
      seed++
      const r1 = seededRandom(seed * 1.13)
      const r2 = seededRandom(seed * 2.47)
      const r3 = seededRandom(seed * 3.89)
      const r4 = seededRandom(seed * 5.17)
      const r5 = seededRandom(seed * 7.31)

      const maxNorm = layer >= 3 ? 1.04 : 1.01
      const xNorm = Math.pow(r1, 0.96) * maxNorm

      grassBlades.push({
        layer,
        xNorm,
        baseYOffset: (r2 - 0.5) * 42,
        height: layerHeights[layer] * (0.68 + r3 * 0.68),
        width: layerWidths[layer] * (0.75 + r4 * 0.5),
        lean: (r5 - 0.45) * 0.44,
        stiffness: 0.08 + (4 - layer) * 0.02 + r2 * 0.03,
        phase: r1 * Math.PI * 6 + r3 * 4,
        hasSeedHead: layer >= 1 && r5 > 0.81,
        bendVelocity: 0,
        currentBend: 0,
      })
    }
  }

  // Hanging canopy vines draping from the top organic border
  for (let i = 0; i < 24; i++) {
    const r1 = seededRandom(i * 17.3 + 5)
    const r2 = seededRandom(i * 29.1 + 19)
    hangingVines.push({
      xNorm: 0.02 + (i / 23) * 0.96 + (r1 - 0.5) * 0.02,
      length: 65 + r2 * 135,
      phase: r1 * Math.PI * 4,
      leafCount: 6 + Math.floor(r2 * 7),
    })
  }

  // Fern fronds across layers 1..4
  for (let i = 0; i < 28; i++) {
    const r1 = seededRandom(i * 19.3 + 4)
    const r2 = seededRandom(i * 23.7 + 9)
    const r3 = seededRandom(i * 31.1 + 15)
    fernFronds.push({
      xNorm: 0.04 + r1 * 0.95,
      baseYOffset: (r2 - 0.5) * 30,
      length: 85 + r3 * 95,
      angle: -0.92 + (r2 - 0.5) * 0.85,
      side: r1 > 0.5 ? 1 : -1,
      phase: r3 * Math.PI * 2,
      pinnaeCount: 12 + Math.floor(r2 * 8),
      layer: 1 + (i % 3),
    })
  }

  // Wildflowers & dandelions across layers 1..4
  const kinds: Wildflower['kind'][] = ['daisy', 'goldcup', 'dandelion', 'glowbell']
  for (let i = 0; i < 42; i++) {
    const r1 = seededRandom(i * 41.2 + 7)
    const r2 = seededRandom(i * 53.9 + 13)
    const r3 = seededRandom(i * 67.3 + 29)
    wildflowers.push({
      layer: 1 + (i % 4),
      xNorm: 0.04 + r1 * 0.95,
      stemHeight: 90 + r2 * 135,
      phase: r3 * Math.PI * 4,
      petalCount: 6 + Math.floor(r1 * 6),
      kind: kinds[i % kinds.length],
      scale: 0.78 + r2 * 0.55,
      currentBend: 0,
      bendVelocity: 0,
    })
  }

  // Floating pollen & glowing forest spores
  for (let i = 0; i < 72; i++) {
    const r1 = seededRandom(i * 13.7 + 101)
    const r2 = seededRandom(i * 29.3 + 203)
    const r3 = seededRandom(i * 47.1 + 307)
    spores.push({
      x: r1,
      y: r2,
      vx: (r3 - 0.45) * 0.00025,
      vy: -0.00018 - r1 * 0.00035,
      radius: 1.3 + r2 * 2.7,
      alpha: 0.38 + r3 * 0.58,
      phase: r1 * Math.PI * 4,
      warm: i % 3 !== 0,
    })
  }

  // Creeping biomechanical seam vines bridging from organic into metallic
  for (let i = 0; i < 14; i++) {
    const r1 = seededRandom(i * 71.3 + 11)
    const r2 = seededRandom(i * 83.9 + 23)
    seamVines.push({
      yNorm: 0.06 + (i / 13) * 0.88 + (r1 - 0.5) * 0.03,
      reachRight: 28 + r1 * 62,
      curveSeed: r2 * Math.PI * 2,
      leafCount: 5 + Math.floor(r1 * 5),
    })
  }
}

function startSeamDrag(e: PointerEvent) {
  isDraggingSeam = true
  ;(e.currentTarget as HTMLElement)?.setPointerCapture?.(e.pointerId)
}

function onPointerDown(e: PointerEvent) {
  if (!panelRoot.value) return
  const rect = panelRoot.value.getBoundingClientRect()
  const normX = (e.clientX - rect.left) / Math.max(1, rect.width)
  if (Math.abs(normX - splitRatio.value) < 0.035) {
    isDraggingSeam = true
  }
}

function onPointerUp() {
  isDraggingSeam = false
}

function onPointerLeave() {
  isDraggingSeam = false
  pointer.active = false
}

function onPointerMove(e: PointerEvent) {
  if (!canvasEl.value) return
  const rect = canvasEl.value.getBoundingClientRect()
  const px = e.clientX - rect.left
  const py = e.clientY - rect.top
  pointer.vx = px - pointer.lastPx
  pointer.vy = py - pointer.lastPy
  pointer.lastPx = px
  pointer.lastPy = py
  pointer.px = px
  pointer.py = py
  pointer.x = Math.max(0, Math.min(1, px / Math.max(1, rect.width)))
  pointer.y = Math.max(0, Math.min(1, py / Math.max(1, rect.height)))
  pointer.active = true

  if (isDraggingSeam) {
    targetSplitRatio = Math.max(0.24, Math.min(0.76, pointer.x))
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ORGANIC WORLD RENDERER (LEFT HALF)
// ─────────────────────────────────────────────────────────────────────────────
function getTerrainY(x: number, splitX: number, h: number, layer: number): number {
  const nx = x / Math.max(1, splitX)
  if (layer === 0) {
    return h * 0.34 - Math.sin(nx * 3.1 + 0.3) * (h * 0.048) - Math.cos(nx * 1.7) * (h * 0.024)
  }
  if (layer === 1) {
    return h * 0.49 + Math.sin(nx * 3.8 + 1.1) * (h * 0.042) - Math.sin(nx * 2.0) * (h * 0.022)
  }
  if (layer === 2) {
    return h * 0.64 + Math.cos(nx * 3.5 + 0.6) * (h * 0.038)
  }
  if (layer === 3) {
    return h * 0.79 + Math.sin(nx * 4.2 + 1.7) * (h * 0.032)
  }
  return h * 0.92 + Math.cos(nx * 5.0 + 2.1) * (h * 0.02)
}

function drawOrganicWorld(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  splitX: number,
  t: number,
  dt: number,
) {
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, 0, splitX, h)
  ctx.clip()

  // 1. Sunlit Forest Canopy & Meadow Sky Gradient
  const skyGrad = ctx.createLinearGradient(0, 0, 0, h)
  skyGrad.addColorStop(0, '#0a2618')
  skyGrad.addColorStop(0.22, '#133e27')
  skyGrad.addColorStop(0.5, '#195434')
  skyGrad.addColorStop(0.8, '#143d25')
  skyGrad.addColorStop(1, '#07190e')
  ctx.fillStyle = skyGrad
  ctx.fillRect(0, 0, splitX, h)

  // Warm Golden-Lime Sunburst in Upper Canopy
  const sunX = splitX * 0.25 + Math.sin(t * 0.25) * 16
  const sunY = h * 0.12 + Math.cos(t * 0.2) * 10
  const sunGlow = ctx.createRadialGradient(sunX, sunY, 6, sunX, sunY, Math.max(splitX, h) * 0.75)
  sunGlow.addColorStop(0, 'rgba(254, 249, 195, 0.62)')
  sunGlow.addColorStop(0.18, 'rgba(217, 249, 157, 0.34)')
  sunGlow.addColorStop(0.45, 'rgba(74, 222, 128, 0.14)')
  sunGlow.addColorStop(1, 'rgba(6, 78, 59, 0)')
  ctx.fillStyle = sunGlow
  ctx.fillRect(0, 0, splitX, h)

  // 2. Volumetric Sunbeams (God Rays) Filtering Across the Grass
  ctx.save()
  ctx.globalCompositeOperation = 'screen'
  for (let i = 0; i < 6; i++) {
    const rayPhase = t * 0.35 + i * 1.2
    const rayAlpha = 0.05 + Math.sin(rayPhase) * 0.022
    const startX = splitX * (0.04 + i * 0.16) + Math.sin(rayPhase * 0.7) * 18
    const topWidth = 42 + (i % 3) * 24
    const botWidth = 145 + (i % 2) * 75
    const skew = splitX * 0.34

    const rayGrad = ctx.createLinearGradient(startX, 0, startX + skew * 0.5, h * 0.9)
    rayGrad.addColorStop(0, `rgba(254, 240, 138, ${rayAlpha * 1.6})`)
    rayGrad.addColorStop(0.55, `rgba(163, 230, 53, ${rayAlpha})`)
    rayGrad.addColorStop(1, 'rgba(34, 197, 94, 0)')

    ctx.fillStyle = rayGrad
    ctx.beginPath()
    ctx.moveTo(startX, 0)
    ctx.lineTo(startX + topWidth, 0)
    ctx.lineTo(startX + skew + botWidth, h * 0.95)
    ctx.lineTo(startX + skew, h * 0.95)
    ctx.closePath()
    ctx.fill()
  }
  ctx.restore()

  // 3. Distant Lush Canopy Cushion Silhouettes
  ctx.fillStyle = 'rgba(10, 42, 26, 0.62)'
  for (let i = 0; i < 8; i++) {
    const tx = (i / 7) * splitX
    const ty = getTerrainY(tx, splitX, h, 0) - 18
    const tr = 58 + (i % 3) * 32
    ctx.beginPath()
    ctx.arc(tx, ty, tr, Math.PI, 0)
    ctx.fill()
  }

  // 4. Render 5 Rolling Meadow Terraces (Hills + Ferns + Grass + Wildflowers)
  const hillPalettes: [string, string, string][] = [
    ['#1b5e3a', '#113e26', '#092416'],
    ['#216e42', '#13472b', '#0a2818'],
    ['#267c49', '#15502f', '#0a2917'],
    ['#29854c', '#15522d', '#082213'],
    ['#25703e', '#123e21', '#05170c'],
  ]

  for (let layer = 0; layer < 5; layer++) {
    ctx.beginPath()
    ctx.moveTo(0, h)
    const steps = 48
    for (let s = 0; s <= steps; s++) {
      const sx = (s / steps) * (splitX + 20)
      const sy = getTerrainY(sx, splitX, h, layer)
      ctx.lineTo(sx, sy)
    }
    ctx.lineTo(splitX + 20, h)
    ctx.closePath()

    const [topCol, midCol, botCol] = hillPalettes[layer]
    const hillY = h * (0.28 + layer * 0.14)
    const hillGrad = ctx.createLinearGradient(0, hillY, 0, h)
    hillGrad.addColorStop(0, topCol)
    hillGrad.addColorStop(0.5, midCol)
    hillGrad.addColorStop(1, botCol)
    ctx.fillStyle = hillGrad
    ctx.fill()

    // Subtle sunlit meadow mist between upper terraces
    if (layer <= 2) {
      const mistY = h * (0.34 + layer * 0.15)
      const mistGrad = ctx.createLinearGradient(0, mistY - 30, 0, mistY + 48)
      mistGrad.addColorStop(0, 'rgba(187, 247, 208, 0)')
      mistGrad.addColorStop(0.5, `rgba(187, 247, 208, ${0.11 - layer * 0.025})`)
      mistGrad.addColorStop(1, 'rgba(187, 247, 208, 0)')
      ctx.fillStyle = mistGrad
      ctx.fillRect(0, mistY - 30, splitX, 78)
    }

    // Fern fronds on this terrace
    for (const fern of fernFronds) {
      if (fern.layer !== layer) continue
      drawFernFrond(ctx, fern, splitX, h, t)
    }

    // Draw grass & wildflowers clipped to left half for layers 0..2
    if (layer < 3) {
      for (const blade of grassBlades) {
        if (blade.layer !== layer) continue
        drawSingleGrassBlade(ctx, blade, splitX, h, t, dt)
      }
      for (const flower of wildflowers) {
        if (flower.layer !== layer) continue
        drawWildflower(ctx, flower, splitX, h, t, dt)
      }
    }

    if (layer === 4) {
      drawMossCushionsAndStones(ctx, splitX, h)
    }
  }

  // 5. Hanging Canopy Vines & Lush Moss Bezel Along Top Edge
  drawTopCanopyVines(ctx, splitX, h, t)

  ctx.restore()

  // 6. Central Biomechanical Seam (Machined Bevel + Creeping Vines over Metal)
  drawBiomechanicalSeam(ctx, h, splitX, t)

  // 7. Foreground Grass Blades (layers 3 & 4) and Wildflowers UNCLIPPED so blades near the seam overlap the metallic edge
  for (let layer = 3; layer <= 4; layer++) {
    for (const blade of grassBlades) {
      if (blade.layer !== layer) continue
      drawSingleGrassBlade(ctx, blade, splitX, h, t, dt)
    }
    for (const flower of wildflowers) {
      if (flower.layer !== layer) continue
      drawWildflower(ctx, flower, splitX, h, t, dt)
    }
  }

  // 8. Floating Golden Pollen, Bioluminescent Spores & Hovering Dragonflies
  drawSporesAndInsects(ctx, splitX, h, t)
}

function drawTopCanopyVines(
  ctx: CanvasRenderingContext2D,
  splitX: number,
  h: number,
  t: number,
) {
  ctx.save()

  // Lush moss/foliage cushion along the upper border
  for (let i = 0; i < 12; i++) {
    const mx = (i / 11) * splitX
    const rx = 55 + (i % 3) * 24
    const ry = 22 + (i % 2) * 14
    const mossGrad = ctx.createRadialGradient(mx, 0, 2, mx, 0, rx)
    mossGrad.addColorStop(0, '#4ade80')
    mossGrad.addColorStop(0.55, '#15803d')
    mossGrad.addColorStop(1, '#064e3b')
    ctx.fillStyle = mossGrad
    ctx.beginPath()
    ctx.ellipse(mx, 0, rx, ry, 0, 0, Math.PI)
    ctx.fill()
  }

  // Hanging weeping-willow / ivy vines swaying in the breeze
  for (const vine of hangingVines) {
    const baseX = vine.xNorm * splitX
    const len = vine.length * (h / 900)
    let sway = Math.sin(t * 1.45 + vine.phase + baseX * 0.008) * 16

    if (pointer.active && pointer.py < len + 90) {
      const dx = baseX - pointer.px
      if (Math.abs(dx) < 110) {
        sway += ((110 - Math.abs(dx)) / 110) * (dx >= 0 ? 28 : -28)
      }
    }

    const ctrlX = baseX + sway * 0.45
    const ctrlY = len * 0.52
    const tipX = baseX + sway
    const tipY = len

    ctx.strokeStyle = '#22c55e'
    ctx.lineWidth = 2.0
    ctx.beginPath()
    ctx.moveTo(baseX, -2)
    ctx.quadraticCurveTo(ctrlX, ctrlY, tipX, tipY)
    ctx.stroke()

    for (let l = 1; l <= vine.leafCount; l++) {
      const u = l / (vine.leafCount + 1)
      const inv = 1 - u
      const lx = inv * inv * baseX + 2 * inv * u * ctrlX + u * u * tipX
      const ly = inv * inv * 0 + 2 * inv * u * ctrlY + u * u * tipY
      const dir = l % 2 === 0 ? 1 : -1

      ctx.save()
      ctx.translate(lx, ly)
      ctx.rotate(dir * 0.65 + (sway / len) * 0.5)
      ctx.fillStyle = u > 0.65 ? '#bef264' : '#4ade80'
      ctx.beginPath()
      ctx.ellipse(dir * 5.5, 0, 6.5, 3.1, 0, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    }
  }

  ctx.restore()
}

function drawFernFrond(
  ctx: CanvasRenderingContext2D,
  fern: FernFrond,
  splitX: number,
  h: number,
  t: number,
) {
  const baseX = fern.xNorm * splitX
  const baseY = getTerrainY(baseX, splitX, h, fern.layer) + fern.baseYOffset
  const wind = Math.sin(t * 1.5 + fern.phase + baseX * 0.01) * 0.14

  let cursorPush = 0
  if (pointer.active) {
    const dx = baseX - pointer.px
    const dy = baseY - fern.length * 0.5 - pointer.py
    const dist = Math.hypot(dx, dy)
    if (dist < 130) {
      cursorPush = ((130 - dist) / 130) * (dx > 0 ? 0.35 : -0.35)
    }
  }

  const totalAngle = fern.angle + wind + cursorPush
  const tipX = baseX + Math.sin(totalAngle) * fern.length * fern.side
  const tipY = baseY - Math.cos(totalAngle * 0.6) * fern.length
  const ctrlX = baseX + Math.sin(totalAngle * 0.5) * fern.length * 0.55 * fern.side
  const ctrlY = baseY - fern.length * 0.58

  ctx.save()
  ctx.strokeStyle = fern.layer <= 2 ? '#15803d' : '#22c55e'
  ctx.lineWidth = 2.2
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(baseX, baseY)
  ctx.quadraticCurveTo(ctrlX, ctrlY, tipX, tipY)
  ctx.stroke()

  for (let p = 2; p < fern.pinnaeCount; p++) {
    const u = p / fern.pinnaeCount
    const inv = 1 - u
    const px = inv * inv * baseX + 2 * inv * u * ctrlX + u * u * tipX
    const py = inv * inv * baseY + 2 * inv * u * ctrlY + u * u * tipY
    const tx = 2 * inv * (ctrlX - baseX) + 2 * u * (tipX - ctrlX)
    const ty = 2 * inv * (ctrlY - baseY) + 2 * u * (tipY - ctrlY)
    const tangAngle = Math.atan2(ty, tx)

    const pinnaLen = Math.sin(u * Math.PI) * (fern.length * 0.22)
    for (const dir of [-1, 1]) {
      const leafAngle = tangAngle + dir * 1.05 + Math.sin(t * 2.2 + p * 0.5) * 0.08
      const lx = px + Math.cos(leafAngle) * pinnaLen
      const ly = py + Math.sin(leafAngle) * pinnaLen
      ctx.fillStyle = u > 0.65 ? '#86efac' : '#4ade80'
      ctx.globalAlpha = fern.layer <= 2 ? 0.75 : 0.92
      ctx.beginPath()
      ctx.moveTo(px, py)
      ctx.quadraticCurveTo(
        (px + lx) * 0.5 + Math.cos(leafAngle - 0.35 * dir) * 4,
        (py + ly) * 0.5 + Math.sin(leafAngle - 0.35 * dir) * 4,
        lx,
        ly,
      )
      ctx.quadraticCurveTo(
        (px + lx) * 0.5 + Math.cos(leafAngle + 0.35 * dir) * 4,
        (py + ly) * 0.5 + Math.sin(leafAngle + 0.35 * dir) * 4,
        px,
        py,
      )
      ctx.fill()
    }
  }
  ctx.restore()
}

function drawSingleGrassBlade(
  ctx: CanvasRenderingContext2D,
  blade: GrassBlade,
  splitX: number,
  h: number,
  t: number,
  dt: number,
) {
  const baseX = blade.xNorm * splitX
  const baseY = getTerrainY(Math.min(baseX, splitX), splitX, h, blade.layer) + blade.baseYOffset
  const scaleH = blade.height * (h / 900)

  const wave1 = Math.sin(t * 1.65 - baseX * 0.0085 + blade.phase) * 0.24
  const wave2 = Math.sin(t * 3.1 - baseX * 0.019 + blade.phase * 1.7) * 0.09
  const gust = Math.max(0, Math.sin(t * 0.62 - baseX * 0.004)) * 0.22
  let targetBend = blade.lean + wave1 + wave2 + gust

  if (pointer.active) {
    const midY = baseY - scaleH * 0.55
    const dx = baseX - pointer.px
    const dy = midY - pointer.py
    const dist = Math.hypot(dx, dy)
    const radius = 150
    if (dist < radius) {
      const influence = Math.pow(1 - dist / radius, 1.6)
      const pushDir = dx >= 0 ? 1 : -1
      const velPush = Math.max(-0.9, Math.min(0.9, pointer.vx * 0.035))
      targetBend += (pushDir * 0.74 + velPush) * influence
    }
  }

  const springK = blade.stiffness * 75
  const damping = 0.84
  const accel = (targetBend - blade.currentBend) * springK
  blade.bendVelocity = (blade.bendVelocity + accel * Math.min(dt, 0.05)) * damping
  blade.currentBend += blade.bendVelocity

  const bend = blade.currentBend
  const midX = baseX + Math.sin(bend * 0.55) * (scaleH * 0.48)
  const midY = baseY - Math.cos(bend * 0.45) * (scaleH * 0.52)
  const tipX = baseX + Math.sin(bend) * (scaleH * 0.92)
  const tipY = baseY - Math.cos(bend * 0.75) * scaleH

  const halfW = blade.width * 0.5
  const midW = blade.width * 0.24

  const grad = ctx.createLinearGradient(baseX, baseY, tipX, tipY)
  if (blade.layer === 0) {
    grad.addColorStop(0, '#0a2918')
    grad.addColorStop(0.6, '#155e37')
    grad.addColorStop(1, '#34d399')
  } else if (blade.layer === 1) {
    grad.addColorStop(0, '#0c311c')
    grad.addColorStop(0.55, '#166534')
    grad.addColorStop(1, '#6ee7b7')
  } else if (blade.layer === 2) {
    grad.addColorStop(0, '#092615')
    grad.addColorStop(0.5, '#15803d')
    grad.addColorStop(0.88, '#4ade80')
    grad.addColorStop(1, '#a3e635')
  } else if (blade.layer === 3) {
    grad.addColorStop(0, '#072011')
    grad.addColorStop(0.48, '#15803d')
    grad.addColorStop(0.84, '#22c55e')
    grad.addColorStop(1, '#bef264')
  } else {
    grad.addColorStop(0, '#05180c')
    grad.addColorStop(0.45, '#166534')
    grad.addColorStop(0.82, '#4ade80')
    grad.addColorStop(1, '#ecfccb')
  }

  ctx.fillStyle = grad
  ctx.beginPath()
  ctx.moveTo(baseX - halfW, baseY)
  ctx.quadraticCurveTo(midX - midW, midY, tipX, tipY)
  ctx.quadraticCurveTo(midX + midW, midY, baseX + halfW, baseY)
  ctx.closePath()
  ctx.fill()

  if (blade.layer >= 2) {
    ctx.strokeStyle =
      blade.layer >= 3 ? 'rgba(236, 252, 203, 0.36)' : 'rgba(187, 247, 208, 0.24)'
    ctx.lineWidth = 0.85
    ctx.beginPath()
    ctx.moveTo(baseX, baseY)
    ctx.quadraticCurveTo(midX, midY, tipX, tipY)
    ctx.stroke()
  }

  if (blade.hasSeedHead) {
    const tangX = tipX - midX
    const tangY = tipY - midY
    const len = Math.max(1, Math.hypot(tangX, tangY))
    const ux = tangX / len
    const uy = tangY / len
    const nx = -uy
    const ny = ux

    ctx.fillStyle = blade.layer >= 3 ? '#ecfccb' : '#a7f3d0'
    for (let s = 0; s < 5; s++) {
      const offset = (s - 2) * 3.8
      const sx = tipX - ux * (s * 3.4) + nx * (s % 2 === 0 ? 2.2 : -2.2)
      const sy = tipY - uy * (s * 3.4) + ny * (s % 2 === 0 ? 2.2 : -2.2) + offset * 0.1
      ctx.beginPath()
      ctx.ellipse(
        sx,
        sy,
        1.6,
        3.8,
        Math.atan2(uy, ux) + (s % 2 === 0 ? 0.35 : -0.35),
        0,
        Math.PI * 2,
      )
      ctx.fill()
    }
  }
}

function drawWildflower(
  ctx: CanvasRenderingContext2D,
  flower: Wildflower,
  splitX: number,
  h: number,
  t: number,
  dt: number,
) {
  const baseX = flower.xNorm * splitX
  const baseY = getTerrainY(Math.min(baseX, splitX), splitX, h, flower.layer) + 6
  const stemH = flower.stemHeight * (h / 900)

  const wind = Math.sin(t * 1.8 - baseX * 0.01 + flower.phase) * 0.26
  let targetBend = wind
  if (pointer.active) {
    const dx = baseX - pointer.px
    const dy = baseY - stemH * 0.7 - pointer.py
    const dist = Math.hypot(dx, dy)
    if (dist < 130) {
      targetBend += ((130 - dist) / 130) * (dx >= 0 ? 0.65 : -0.65)
    }
  }

  flower.bendVelocity = (flower.bendVelocity + (targetBend - flower.currentBend) * 4.2 * dt) * 0.85
  flower.currentBend += flower.bendVelocity

  const ctrlX = baseX + Math.sin(flower.currentBend * 0.5) * (stemH * 0.45)
  const ctrlY = baseY - stemH * 0.52
  const headX = baseX + Math.sin(flower.currentBend) * (stemH * 0.88)
  const headY = baseY - Math.cos(flower.currentBend * 0.65) * stemH

  ctx.save()
  ctx.strokeStyle = '#4ade80'
  ctx.lineWidth = 1.8 * flower.scale
  ctx.beginPath()
  ctx.moveTo(baseX, baseY)
  ctx.quadraticCurveTo(ctrlX, ctrlY, headX, headY)
  ctx.stroke()

  const r = 7.5 * flower.scale
  if (flower.kind === 'dandelion') {
    const puffGrad = ctx.createRadialGradient(headX, headY, 1, headX, headY, r * 1.9)
    puffGrad.addColorStop(0, 'rgba(255, 255, 255, 0.92)')
    puffGrad.addColorStop(0.55, 'rgba(226, 252, 233, 0.45)')
    puffGrad.addColorStop(1, 'rgba(226, 252, 233, 0)')
    ctx.fillStyle = puffGrad
    ctx.beginPath()
    ctx.arc(headX, headY, r * 1.9, 0, Math.PI * 2)
    ctx.fill()

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)'
    ctx.lineWidth = 0.7
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2 + t * 0.15
      ctx.beginPath()
      ctx.moveTo(headX, headY)
      ctx.lineTo(headX + Math.cos(a) * r * 1.45, headY + Math.sin(a) * r * 1.45)
      ctx.stroke()
    }
  } else if (flower.kind === 'daisy' || flower.kind === 'goldcup') {
    const isGold = flower.kind === 'goldcup'
    ctx.fillStyle = isGold ? '#fde047' : '#f8fafc'
    for (let p = 0; p < flower.petalCount; p++) {
      const a = (p / flower.petalCount) * Math.PI * 2 + flower.currentBend * 0.4
      const px = headX + Math.cos(a) * (r * 0.85)
      const py = headY + Math.sin(a) * (r * 0.65)
      ctx.beginPath()
      ctx.ellipse(px, py, r * 0.65, r * 0.28, a, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.fillStyle = isGold ? '#f59e0b' : '#facc15'
    ctx.beginPath()
    ctx.arc(headX, headY, r * 0.36, 0, Math.PI * 2)
    ctx.fill()
  } else {
    const glow = ctx.createRadialGradient(headX, headY, 1, headX, headY, r * 2.2)
    glow.addColorStop(0, 'rgba(167, 243, 208, 0.95)')
    glow.addColorStop(0.45, 'rgba(52, 211, 153, 0.42)')
    glow.addColorStop(1, 'rgba(16, 185, 129, 0)')
    ctx.fillStyle = glow
    ctx.beginPath()
    ctx.arc(headX, headY, r * 2.2, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}

function drawMossCushionsAndStones(ctx: CanvasRenderingContext2D, splitX: number, h: number) {
  ctx.save()
  const moundPositions = [0.1, 0.26, 0.44, 0.62, 0.8, 0.95]
  for (let i = 0; i < moundPositions.length; i++) {
    const mx = moundPositions[i] * splitX
    const my = h - 8 + (i % 2) * 8
    const rx = 54 + (i % 3) * 28
    const ry = 25 + (i % 2) * 12

    if (i % 2 === 1) {
      const stoneGrad = ctx.createRadialGradient(
        mx - rx * 0.2,
        my - ry * 0.6,
        4,
        mx,
        my,
        rx * 0.95,
      )
      stoneGrad.addColorStop(0, '#64748b')
      stoneGrad.addColorStop(0.55, '#334155')
      stoneGrad.addColorStop(1, '#0f172a')
      ctx.fillStyle = stoneGrad
      ctx.beginPath()
      ctx.ellipse(mx + 14, my - 4, rx * 0.72, ry * 0.78, -0.12, Math.PI, 0)
      ctx.fill()
    }

    const mossGrad = ctx.createRadialGradient(mx - rx * 0.2, my - ry * 0.7, 4, mx, my, rx)
    mossGrad.addColorStop(0, '#a3e635')
    mossGrad.addColorStop(0.45, '#22c55e')
    mossGrad.addColorStop(0.85, '#14532d')
    mossGrad.addColorStop(1, '#052e16')
    ctx.fillStyle = mossGrad
    ctx.beginPath()
    ctx.ellipse(mx, my, rx, ry, 0, Math.PI, 0)
    ctx.fill()
  }
  ctx.restore()
}

function drawSporesAndInsects(
  ctx: CanvasRenderingContext2D,
  splitX: number,
  h: number,
  t: number,
) {
  ctx.save()
  for (const s of spores) {
    s.x += s.vx + Math.sin(t * 0.9 + s.phase) * 0.00035
    s.y += s.vy
    if (s.y < -0.04) {
      s.y = 0.98
      s.x = Math.random() * 0.98
    }
    if (s.x > 1.02) s.x = 0.02
    if (s.x < 0) s.x = 0.96

    const px = s.x * splitX
    const py = s.y * h
    const pulse = 0.55 + Math.sin(t * 2.6 + s.phase) * 0.45
    const rad = s.radius * (0.85 + pulse * 0.35)

    const glow = ctx.createRadialGradient(px, py, 0.5, px, py, rad * 3.4)
    if (s.warm) {
      glow.addColorStop(0, `rgba(254, 249, 195, ${s.alpha * pulse})`)
      glow.addColorStop(0.45, `rgba(190, 242, 100, ${s.alpha * pulse * 0.55})`)
      glow.addColorStop(1, 'rgba(163, 230, 53, 0)')
    } else {
      glow.addColorStop(0, `rgba(209, 250, 229, ${s.alpha * pulse})`)
      glow.addColorStop(0.45, `rgba(52, 211, 153, ${s.alpha * pulse * 0.55})`)
      glow.addColorStop(1, 'rgba(16, 185, 129, 0)')
    }
    ctx.fillStyle = glow
    ctx.beginPath()
    ctx.arc(px, py, rad * 3.4, 0, Math.PI * 2)
    ctx.fill()
  }

  for (let d = 0; d < 2; d++) {
    const dfPhase = t * (0.65 + d * 0.22) + d * 3.7
    const dx =
      splitX * (0.38 + d * 0.28 + Math.sin(dfPhase) * 0.22 + Math.cos(dfPhase * 2.1) * 0.06)
    const dy =
      h * (0.28 + d * 0.22 + Math.cos(dfPhase * 1.3) * 0.11 + Math.sin(dfPhase * 2.7) * 0.03)
    const heading = Math.cos(dfPhase) * 0.25 + (d === 0 ? 0.15 : -0.2)
    const wingBeat = Math.sin(t * 42 + d * 2) * 0.48

    ctx.save()
    ctx.translate(dx, dy)
    ctx.rotate(heading)

    ctx.fillStyle = 'rgba(224, 242, 254, 0.44)'
    ctx.strokeStyle = 'rgba(167, 243, 208, 0.68)'
    ctx.lineWidth = 0.7
    for (const side of [-1, 1]) {
      for (const pair of [-0.18, 0.18]) {
        ctx.save()
        ctx.rotate(side * (1.2 + wingBeat) + pair)
        ctx.beginPath()
        ctx.ellipse(side * 12, 0, 12, 2.8, 0, 0, Math.PI * 2)
        ctx.fill()
        ctx.stroke()
        ctx.restore()
      }
    }

    ctx.strokeStyle = '#34d399'
    ctx.lineWidth = 2.1
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(0, -7)
    ctx.lineTo(0, 16)
    ctx.stroke()

    ctx.fillStyle = '#a7f3d0'
    ctx.beginPath()
    ctx.arc(0, -8, 2.2, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }
  ctx.restore()
}

// ─────────────────────────────────────────────────────────────────────────────
// METALLIC MECHANICAL PANEL RENDERER (RIGHT HALF)
// ─────────────────────────────────────────────────────────────────────────────
function drawMetallicWorld(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  splitX: number,
  t: number,
  dt: number,
) {
  const mechW = Math.max(1, w - splitX)
  ctx.save()
  ctx.beginPath()
  ctx.rect(splitX, 0, mechW, h)
  ctx.clip()

  // 1. Brushed Anodized Gunmetal Base Sub-Chassis
  const baseGrad = ctx.createLinearGradient(splitX, 0, w, h)
  baseGrad.addColorStop(0, '#070a0f')
  baseGrad.addColorStop(0.5, '#0d121b')
  baseGrad.addColorStop(1, '#06080d')
  ctx.fillStyle = baseGrad
  ctx.fillRect(splitX, 0, mechW, h)

  // Precision blueprint grid inside the machine bay
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.055)'
  ctx.lineWidth = 1
  const gridStep = 34
  for (let gx = Math.floor(splitX / gridStep) * gridStep; gx < w; gx += gridStep) {
    ctx.beginPath()
    ctx.moveTo(gx, 0)
    ctx.lineTo(gx, h)
    ctx.stroke()
  }
  for (let gy = gridStep; gy < h; gy += gridStep) {
    ctx.beginPath()
    ctx.moveTo(splitX, gy)
    ctx.lineTo(w, gy)
    ctx.stroke()
  }

  const cx = splitX + mechW * 0.52
  const cy = h * 0.52
  const scale = Math.min(mechW / 700, h / 800) * 1.06

  // 2. Copper & Emerald Power Conduits (Pulsing Busbars)
  drawPowerConduits(ctx, splitX, w, h, cx, cy, scale, t)

  // 3. Upper Right: Spinning Multi-Blade Cooling Turbine & Motorized Louvers
  const turbX = splitX + mechW * 0.76
  const turbY = h * 0.24
  drawCoolingTurbineAndLouvers(ctx, turbX, turbY, 92 * scale, mechPhase, t)

  // 4. Upper Left: Horological Balance Wheel Escapement & Hairspring
  const escX = splitX + mechW * 0.26
  const escY = h * 0.22
  drawBalanceEscapement(ctx, escX, escY, 80 * scale, t)

  // 5. Center-Right: Dual Reciprocating Hydraulic Pistons & Crankshaft
  const crankX = cx - 44 * scale
  const crankY = cy + 8 * scale
  const mainGearRadius = 114 * scale
  const mainGearAngle = mechPhase * 0.85

  drawHydraulicPistons(ctx, crankX, crankY, mainGearAngle, 54 * scale, scale, dt)

  // 6. Lower Left: Cam-Driven Rocker Actuator & Compressing Helical Spring
  const camX = splitX + mechW * 0.24
  const camY = h * 0.73
  drawCamActuatorAndSpring(ctx, camX, camY, scale, mechPhase)

  // 7. Center: Synchronized Multi-Gear Planetary & Spur Gear Train
  drawInterlockingGearTrain(ctx, crankX, crankY, mainGearRadius, mainGearAngle, scale)

  // 8. Bottom Bay: Linear Rack & Pinion Precision Carriage
  drawLinearRackAndPinion(ctx, splitX + mechW * 0.54, h * 0.89, scale, mechPhase)

  // 9. Machined Brushed Titanium Perimeter Armor Plates, Bevels & Hex Bolts
  drawBrushedArmorPlates(ctx, splitX, w, h, scale, mechSpeedMultiplier)

  ctx.restore()
}

function drawPowerConduits(
  ctx: CanvasRenderingContext2D,
  splitX: number,
  w: number,
  h: number,
  cx: number,
  cy: number,
  scale: number,
  t: number,
) {
  ctx.save()
  const pipes = [
    { y1: h * 0.28, y2: cy - 30 * scale, color: '#10b981', glow: 'rgba(16, 185, 129, 0.35)' },
    { y1: h * 0.50, y2: cy + 12 * scale, color: '#d97706', glow: 'rgba(245, 158, 11, 0.32)' },
    { y1: h * 0.72, y2: cy + 65 * scale, color: '#38bdf8', glow: 'rgba(56, 189, 248, 0.28)' },
  ]

  for (let i = 0; i < pipes.length; i++) {
    const p = pipes[i]
    const midX = splitX + (cx - splitX) * (0.42 + i * 0.12)

    ctx.strokeStyle = '#1e293b'
    ctx.lineWidth = 12 * scale
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.moveTo(splitX, p.y1)
    ctx.lineTo(midX, p.y1)
    ctx.lineTo(midX + 42 * scale, p.y2)
    ctx.lineTo(w, p.y2)
    ctx.stroke()

    ctx.strokeStyle = p.color
    ctx.lineWidth = 3 * scale
    ctx.shadowColor = p.glow
    ctx.shadowBlur = 10
    ctx.beginPath()
    ctx.moveTo(splitX, p.y1)
    ctx.lineTo(midX, p.y1)
    ctx.lineTo(midX + 42 * scale, p.y2)
    ctx.lineTo(w, p.y2)
    ctx.stroke()

    const pulseProgress = (t * 0.55 + i * 0.33) % 1
    const pulseX = splitX + pulseProgress * (w - splitX)
    const pulseY =
      pulseX < midX
        ? p.y1
        : pulseX < midX + 42 * scale
          ? p.y1 + ((pulseX - midX) / (42 * scale)) * (p.y2 - p.y1)
          : p.y2

    ctx.fillStyle = '#ffffff'
    ctx.beginPath()
    ctx.arc(pulseX, pulseY, 4.2 * scale, 0, Math.PI * 2)
    ctx.fill()
    ctx.shadowBlur = 0
  }
  ctx.restore()
}

function drawPrecisionGear(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  pitchRadius: number,
  teeth: number,
  angle: number,
  finish: 'titanium' | 'bronze' | 'steel' | 'gunmetal',
  spokes: number,
  holeRadiusRatio = 0.24,
) {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(angle)

  const toothHeight = Math.max(5, ((pitchRadius * Math.PI) / teeth) * 0.72)
  const outerR = pitchRadius + toothHeight * 0.52
  const rootR = pitchRadius - toothHeight * 0.48
  const step = (Math.PI * 2) / teeth

  ctx.shadowColor = 'rgba(0, 0, 0, 0.72)'
  ctx.shadowBlur = 16
  ctx.shadowOffsetX = 4
  ctx.shadowOffsetY = 6

  ctx.beginPath()
  for (let i = 0; i < teeth; i++) {
    const a = i * step
    const a0 = a - step * 0.34
    const a1 = a - step * 0.18
    const a2 = a + step * 0.18
    const a3 = a + step * 0.34

    if (i === 0) {
      ctx.moveTo(Math.cos(a0) * rootR, Math.sin(a0) * rootR)
    } else {
      ctx.lineTo(Math.cos(a0) * rootR, Math.sin(a0) * rootR)
    }
    ctx.lineTo(Math.cos(a1) * outerR, Math.sin(a1) * outerR)
    ctx.lineTo(Math.cos(a2) * outerR, Math.sin(a2) * outerR)
    ctx.lineTo(Math.cos(a3) * rootR, Math.sin(a3) * rootR)
  }
  ctx.closePath()

  const grad = ctx.createLinearGradient(-outerR, -outerR, outerR, outerR)
  if (finish === 'bronze') {
    grad.addColorStop(0, '#78350f')
    grad.addColorStop(0.28, '#d97706')
    grad.addColorStop(0.5, '#fde68a')
    grad.addColorStop(0.74, '#b45309')
    grad.addColorStop(1, '#451a03')
  } else if (finish === 'steel') {
    grad.addColorStop(0, '#334155')
    grad.addColorStop(0.32, '#94a3b8')
    grad.addColorStop(0.5, '#f8fafc')
    grad.addColorStop(0.7, '#64748b')
    grad.addColorStop(1, '#1e293b')
  } else if (finish === 'gunmetal') {
    grad.addColorStop(0, '#0f172a')
    grad.addColorStop(0.35, '#334155')
    grad.addColorStop(0.52, '#64748b')
    grad.addColorStop(0.75, '#1e293b')
    grad.addColorStop(1, '#090d16')
  } else {
    grad.addColorStop(0, '#1e293b')
    grad.addColorStop(0.3, '#64748b')
    grad.addColorStop(0.48, '#cbd5e1')
    grad.addColorStop(0.68, '#475569')
    grad.addColorStop(1, '#0f172a')
  }

  ctx.fillStyle = grad
  ctx.fill()

  ctx.shadowColor = 'transparent'
  ctx.shadowBlur = 0
  ctx.shadowOffsetX = 0
  ctx.shadowOffsetY = 0

  ctx.strokeStyle =
    finish === 'bronze' ? 'rgba(254, 243, 199, 0.42)' : 'rgba(226, 232, 240, 0.35)'
  ctx.lineWidth = 1.2
  ctx.stroke()

  const webR = rootR * 0.84
  const hubR = rootR * (holeRadiusRatio + 0.14)

  ctx.fillStyle = 'rgba(9, 13, 22, 0.55)'
  ctx.beginPath()
  ctx.arc(0, 0, webR, 0, Math.PI * 2)
  ctx.fill()

  if (spokes > 0) {
    ctx.strokeStyle = grad
    ctx.lineWidth = Math.max(4, pitchRadius * 0.13)
    for (let s = 0; s < spokes; s++) {
      const sa = (s / spokes) * Math.PI * 2
      ctx.beginPath()
      ctx.moveTo(Math.cos(sa) * hubR * 0.7, Math.sin(sa) * hubR * 0.7)
      ctx.lineTo(Math.cos(sa) * webR, Math.sin(sa) * webR)
      ctx.stroke()
    }
  }

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.24)'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.arc(0, 0, webR, 0, Math.PI * 2)
  ctx.stroke()

  const hubGrad = ctx.createRadialGradient(-hubR * 0.3, -hubR * 0.3, 2, 0, 0, hubR)
  hubGrad.addColorStop(0, '#e2e8f0')
  hubGrad.addColorStop(0.55, '#475569')
  hubGrad.addColorStop(1, '#0f172a')
  ctx.fillStyle = hubGrad
  ctx.beginPath()
  ctx.arc(0, 0, hubR, 0, Math.PI * 2)
  ctx.fill()

  const boreR = rootR * holeRadiusRatio * 0.65
  ctx.fillStyle = '#090d14'
  ctx.beginPath()
  ctx.arc(0, 0, boreR, 0, Math.PI * 2)
  ctx.fill()

  ctx.strokeStyle = 'rgba(148, 163, 184, 0.5)'
  ctx.lineWidth = 1.4
  ctx.stroke()

  ctx.restore()
}

function drawInterlockingGearTrain(
  ctx: CanvasRenderingContext2D,
  crankX: number,
  crankY: number,
  mainR: number,
  mainAngle: number,
  scale: number,
) {
  const mainTeeth = 32

  // 1. Secondary Bronze Idler Gear (upper-right of main gear)
  const idlerTeeth = 20
  const idlerR = mainR * (idlerTeeth / mainTeeth)
  const idlerDirAngle = -0.58
  const centerDist1 = mainR + idlerR
  const idlerX = crankX + Math.cos(idlerDirAngle) * centerDist1
  const idlerY = crankY + Math.sin(idlerDirAngle) * centerDist1
  const idlerAngle =
    -mainAngle * (mainTeeth / idlerTeeth) +
    Math.PI / idlerTeeth +
    idlerDirAngle * (1 + mainTeeth / idlerTeeth)

  // 2. High-Speed Chrome Pinion Gear
  const pinionTeeth = 12
  const pinionR = mainR * (pinionTeeth / mainTeeth)
  const pinionDirAngle = 0.35
  const centerDist2 = idlerR + pinionR
  const pinionX = idlerX + Math.cos(pinionDirAngle) * centerDist2
  const pinionY = idlerY + Math.sin(pinionDirAngle) * centerDist2
  const pinionAngle =
    -idlerAngle * (idlerTeeth / pinionTeeth) +
    Math.PI / pinionTeeth +
    pinionDirAngle * (1 + idlerTeeth / pinionTeeth)

  // 3. Lower Gunmetal Torque Gear
  const lowerTeeth = 24
  const lowerR = mainR * (lowerTeeth / mainTeeth)
  const lowerDirAngle = 2.18
  const centerDist3 = mainR + lowerR
  const lowerX = crankX + Math.cos(lowerDirAngle) * centerDist3
  const lowerY = crankY + Math.sin(lowerDirAngle) * centerDist3
  const lowerAngle =
    -mainAngle * (mainTeeth / lowerTeeth) +
    Math.PI / lowerTeeth +
    lowerDirAngle * (1 + mainTeeth / lowerTeeth)

  // 4. Left Seam Coupling Gear (meshed near the biomechanical seam!)
  const seamGearTeeth = 16
  const seamGearR = mainR * (seamGearTeeth / mainTeeth)
  const seamDirAngle = 3.08
  const centerDist4 = mainR + seamGearR
  const seamGearX = crankX + Math.cos(seamDirAngle) * centerDist4
  const seamGearY = crankY + Math.sin(seamDirAngle) * centerDist4
  const seamGearAngle =
    -mainAngle * (mainTeeth / seamGearTeeth) +
    Math.PI / seamGearTeeth +
    seamDirAngle * (1 + mainTeeth / seamGearTeeth)

  drawPrecisionGear(ctx, lowerX, lowerY, lowerR, lowerTeeth, lowerAngle, 'gunmetal', 5, 0.22)
  drawPrecisionGear(ctx, seamGearX, seamGearY, seamGearR, seamGearTeeth, seamGearAngle, 'bronze', 4, 0.24)
  drawPrecisionGear(ctx, crankX, crankY, mainR, mainTeeth, mainAngle, 'titanium', 6, 0.25)
  drawPrecisionGear(ctx, idlerX, idlerY, idlerR, idlerTeeth, idlerAngle, 'bronze', 5, 0.24)
  drawPrecisionGear(ctx, pinionX, pinionY, pinionR, pinionTeeth, pinionAngle, 'steel', 4, 0.26)

  // Orbiting 3-Planet Epicyclic Cluster inside the Main Drive Gear Hub
  const orbitR = mainR * 0.48
  const carrierAngle = -mainAngle * 0.45
  for (let p = 0; p < 3; p++) {
    const pa = carrierAngle + (p / 3) * Math.PI * 2
    const px = crankX + Math.cos(pa) * orbitR
    const py = crankY + Math.sin(pa) * orbitR
    drawPrecisionGear(ctx, px, py, mainR * 0.21, 10, mainAngle * 2.4, 'steel', 3, 0.25)
  }

  // Machined Steel Bridge Strap connecting the gear axles
  ctx.save()
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.42)'
  ctx.lineWidth = 10 * scale
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  ctx.moveTo(seamGearX, seamGearY)
  ctx.lineTo(crankX, crankY)
  ctx.lineTo(lowerX, lowerY)
  ctx.moveTo(crankX, crankY)
  ctx.lineTo(idlerX, idlerY)
  ctx.lineTo(pinionX, pinionY)
  ctx.stroke()

  ctx.strokeStyle = '#1e293b'
  ctx.lineWidth = 5 * scale
  ctx.stroke()

  for (const [px, py, col] of [
    [crankX, crankY, '#10b981'],
    [idlerX, idlerY, '#f59e0b'],
    [pinionX, pinionY, '#38bdf8'],
    [lowerX, lowerY, '#10b981'],
    [seamGearX, seamGearY, '#10b981'],
  ] as const) {
    ctx.fillStyle = col
    ctx.beginPath()
    ctx.arc(px, py, 6.5 * scale, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = '#e2e8f0'
    ctx.lineWidth = 1.6 * scale
    ctx.stroke()
  }
  ctx.restore()
}

function drawHydraulicPistons(
  ctx: CanvasRenderingContext2D,
  crankX: number,
  crankY: number,
  crankAngle: number,
  crankRadius: number,
  scale: number,
  dt: number,
) {
  const cylinders = [
    { angle: 0.22, phaseOffset: 0, rodLen: 185 * scale, boreW: 54 * scale },
    { angle: 0.92, phaseOffset: Math.PI * 0.65, rodLen: 185 * scale, boreW: 48 * scale },
  ]

  for (let c = 0; c < cylinders.length; c++) {
    const cyl = cylinders[c]
    const pinAngle = crankAngle + cyl.phaseOffset

    ctx.save()
    ctx.translate(crankX, crankY)
    ctx.rotate(cyl.angle)

    const relAngle = pinAngle - cyl.angle
    const localPinX = Math.cos(relAngle) * crankRadius
    const localPinY = Math.sin(relAngle) * crankRadius

    const L = cyl.rodLen
    const underRoot = Math.max(1, L * L - localPinY * localPinY)
    const wristX = localPinX + Math.sqrt(underRoot)

    const cylStartX = crankRadius + L - 58 * scale
    const cylEndX = crankRadius + L + 78 * scale
    const halfBore = cyl.boreW * 0.5

    const housingGrad = ctx.createLinearGradient(0, -halfBore - 10, 0, halfBore + 10)
    housingGrad.addColorStop(0, '#0f172a')
    housingGrad.addColorStop(0.28, '#475569')
    housingGrad.addColorStop(0.5, '#1e293b')
    housingGrad.addColorStop(0.8, '#334155')
    housingGrad.addColorStop(1, '#090d16')

    ctx.fillStyle = housingGrad
    ctx.beginPath()
    ctx.roundRect(
      cylStartX,
      -halfBore - 10 * scale,
      cylEndX - cylStartX,
      cyl.boreW + 20 * scale,
      8 * scale,
    )
    ctx.fill()
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.38)'
    ctx.lineWidth = 1.5
    ctx.stroke()

    ctx.fillStyle = '#334155'
    for (let fx = cylStartX + 12 * scale; fx < cylEndX - 10 * scale; fx += 11 * scale) {
      ctx.fillRect(fx, -halfBore - 16 * scale, 4 * scale, 6 * scale)
      ctx.fillRect(fx, halfBore + 10 * scale, 4 * scale, 6 * scale)
    }

    ctx.fillStyle = '#070a10'
    ctx.fillRect(cylStartX + 6 * scale, -halfBore, cylEndX - cylStartX - 16 * scale, cyl.boreW)

    const maxWrist = crankRadius + L
    const minWrist = -crankRadius + L
    const compression = Math.max(0, Math.min(1, (wristX - minWrist) / (maxWrist - minWrist)))

    const chamberX = wristX + 22 * scale
    const chamberW = Math.max(4, cylEndX - 12 * scale - chamberX)
    const compGlow = ctx.createLinearGradient(chamberX, 0, cylEndX, 0)
    compGlow.addColorStop(0, `rgba(16, 185, 129, ${0.15 + compression * 0.72})`)
    compGlow.addColorStop(1, `rgba(56, 189, 248, ${0.08 + compression * 0.55})`)
    ctx.fillStyle = compGlow
    ctx.fillRect(chamberX, -halfBore + 3 * scale, chamberW, cyl.boreW - 6 * scale)

    const pistonW = 38 * scale
    const pistonGrad = ctx.createLinearGradient(0, -halfBore, 0, halfBore)
    pistonGrad.addColorStop(0, '#475569')
    pistonGrad.addColorStop(0.35, '#e2e8f0')
    pistonGrad.addColorStop(0.5, '#ffffff')
    pistonGrad.addColorStop(0.7, '#94a3b8')
    pistonGrad.addColorStop(1, '#1e293b')

    ctx.fillStyle = pistonGrad
    ctx.beginPath()
    ctx.roundRect(
      wristX - pistonW * 0.45,
      -halfBore + 2 * scale,
      pistonW,
      cyl.boreW - 4 * scale,
      4 * scale,
    )
    ctx.fill()

    ctx.fillStyle = '#f59e0b'
    ctx.fillRect(wristX + pistonW * 0.22, -halfBore + 2 * scale, 3 * scale, cyl.boreW - 4 * scale)
    ctx.fillRect(wristX + pistonW * 0.34, -halfBore + 2 * scale, 3 * scale, cyl.boreW - 4 * scale)

    ctx.strokeStyle = '#94a3b8'
    ctx.lineWidth = 11 * scale
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(localPinX, localPinY)
    ctx.lineTo(wristX, 0)
    ctx.stroke()

    ctx.strokeStyle = '#1e293b'
    ctx.lineWidth = 4.5 * scale
    ctx.beginPath()
    ctx.moveTo(localPinX, localPinY)
    ctx.lineTo(wristX, 0)
    ctx.stroke()

    for (const [bx, by, br] of [
      [localPinX, localPinY, 9 * scale],
      [wristX, 0, 7.5 * scale],
    ] as const) {
      ctx.fillStyle = '#e2e8f0'
      ctx.beginPath()
      ctx.arc(bx, by, br, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#0f172a'
      ctx.beginPath()
      ctx.arc(bx, by, br * 0.45, 0, Math.PI * 2)
      ctx.fill()
    }

    ctx.restore()

    if (compression > 0.94 && steamPuffs.length < 28 && Math.random() < 0.35) {
      const headDist = crankRadius + L + 78 * scale
      const sx = crankX + Math.cos(cyl.angle) * headDist
      const sy = crankY + Math.sin(cyl.angle) * headDist
      steamPuffs.push({
        x: sx,
        y: sy,
        vx: Math.cos(cyl.angle) * (18 + Math.random() * 24),
        vy: Math.sin(cyl.angle) * (18 + Math.random() * 24) - 15,
        life: 0,
        maxLife: 0.65 + Math.random() * 0.4,
        size: (5 + Math.random() * 6) * scale,
      })
    }
  }

  ctx.save()
  for (let i = steamPuffs.length - 1; i >= 0; i--) {
    const p = steamPuffs[i]
    p.life += dt
    if (p.life >= p.maxLife) {
      steamPuffs.splice(i, 1)
      continue
    }
    p.x += p.vx * dt
    p.y += p.vy * dt
    const prog = p.life / p.maxLife
    const alpha = (1 - prog) * 0.28
    const rad = p.size * (1 + prog * 2.2)
    const grad = ctx.createRadialGradient(p.x, p.y, 1, p.x, p.y, rad)
    grad.addColorStop(0, `rgba(226, 232, 240, ${alpha})`)
    grad.addColorStop(1, 'rgba(148, 163, 184, 0)')
    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.arc(p.x, p.y, rad, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}

function drawBalanceEscapement(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  t: number,
) {
  ctx.save()
  ctx.translate(x, y)

  ctx.fillStyle = '#070a10'
  ctx.beginPath()
  ctx.arc(0, 0, radius * 1.16, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.32)'
  ctx.lineWidth = 2
  ctx.stroke()

  const osc = Math.sin(t * 5.2) * 1.15
  const hairspringBreath = 1 + Math.sin(t * 5.2) * 0.14

  ctx.strokeStyle = '#38bdf8'
  ctx.lineWidth = 1.35
  ctx.beginPath()
  const turns = 4.5
  const steps = 110
  for (let i = 0; i <= steps; i++) {
    const u = i / steps
    const a = u * Math.PI * 2 * turns + osc * u
    const r = radius * 0.1 + u * radius * 0.42 * hairspringBreath
    const sx = Math.cos(a) * r
    const sy = Math.sin(a) * r
    if (i === 0) ctx.moveTo(sx, sy)
    else ctx.lineTo(sx, sy)
  }
  ctx.stroke()

  ctx.save()
  ctx.rotate(osc)

  const wheelGrad = ctx.createLinearGradient(-radius, -radius, radius, radius)
  wheelGrad.addColorStop(0, '#92400e')
  wheelGrad.addColorStop(0.35, '#fbbf24')
  wheelGrad.addColorStop(0.52, '#fef3c7')
  wheelGrad.addColorStop(0.75, '#d97706')
  wheelGrad.addColorStop(1, '#78350f')

  ctx.strokeStyle = wheelGrad
  ctx.lineWidth = radius * 0.13
  ctx.beginPath()
  ctx.arc(0, 0, radius * 0.86, 0, Math.PI * 2)
  ctx.stroke()

  ctx.lineWidth = radius * 0.08
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2
    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.lineTo(Math.cos(a) * radius * 0.84, Math.sin(a) * radius * 0.84)
    ctx.stroke()
  }

  ctx.fillStyle = '#fde68a'
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2
    ctx.beginPath()
    ctx.arc(
      Math.cos(a) * (radius * 0.96),
      Math.sin(a) * (radius * 0.96),
      radius * 0.045,
      0,
      Math.PI * 2,
    )
    ctx.fill()
  }
  ctx.restore()

  ctx.strokeStyle = '#94a3b8'
  ctx.lineWidth = radius * 0.16
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(-radius * 1.1, -radius * 0.22)
  ctx.quadraticCurveTo(-radius * 0.4, -radius * 0.05, 0, 0)
  ctx.stroke()

  ctx.fillStyle = '#ec4899'
  ctx.beginPath()
  ctx.arc(0, 0, radius * 0.11, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = '#fde68a'
  ctx.lineWidth = 1.6
  ctx.stroke()

  ctx.restore()
}

function drawCoolingTurbineAndLouvers(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  phase: number,
  t: number,
) {
  ctx.save()
  ctx.translate(x, y)

  const shroudGrad = ctx.createRadialGradient(0, 0, radius * 0.2, 0, 0, radius * 1.15)
  shroudGrad.addColorStop(0, '#070a10')
  shroudGrad.addColorStop(0.82, '#0f172a')
  shroudGrad.addColorStop(1, '#334155')
  ctx.fillStyle = shroudGrad
  ctx.beginPath()
  ctx.arc(0, 0, radius * 1.12, 0, Math.PI * 2)
  ctx.fill()

  const coreGlow = ctx.createRadialGradient(0, 0, 2, 0, 0, radius * 0.9)
  coreGlow.addColorStop(0, 'rgba(16, 185, 129, 0.38)')
  coreGlow.addColorStop(0.6, 'rgba(56, 189, 248, 0.12)')
  coreGlow.addColorStop(1, 'rgba(15, 23, 42, 0)')
  ctx.fillStyle = coreGlow
  ctx.beginPath()
  ctx.arc(0, 0, radius * 0.9, 0, Math.PI * 2)
  ctx.fill()

  ctx.save()
  ctx.rotate(phase * 2.4)
  const blades = 14
  for (let i = 0; i < blades; i++) {
    ctx.save()
    ctx.rotate((i / blades) * Math.PI * 2)
    const bladeGrad = ctx.createLinearGradient(0, 0, radius * 0.95, 0)
    bladeGrad.addColorStop(0, '#334155')
    bladeGrad.addColorStop(0.6, '#cbd5e1')
    bladeGrad.addColorStop(1, '#475569')
    ctx.fillStyle = bladeGrad
    ctx.beginPath()
    ctx.moveTo(radius * 0.22, -2)
    ctx.quadraticCurveTo(radius * 0.62, -radius * 0.22, radius * 0.96, -radius * 0.06)
    ctx.lineTo(radius * 0.94, radius * 0.1)
    ctx.quadraticCurveTo(radius * 0.56, -radius * 0.04, radius * 0.22, 5)
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  }
  ctx.restore()

  ctx.strokeStyle = '#64748b'
  ctx.lineWidth = 3.5
  for (let s = 0; s < 4; s++) {
    const a = (s / 4) * Math.PI * 2 + Math.PI * 0.25
    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.lineTo(Math.cos(a) * radius * 1.08, Math.sin(a) * radius * 1.08)
    ctx.stroke()
  }

  ctx.strokeStyle = '#94a3b8'
  ctx.lineWidth = 5
  ctx.beginPath()
  ctx.arc(0, 0, radius * 1.08, 0, Math.PI * 2)
  ctx.stroke()

  ctx.fillStyle = '#e2e8f0'
  ctx.beginPath()
  ctx.arc(0, 0, radius * 0.24, 0, Math.PI * 2)
  ctx.fill()

  const louverY = radius * 1.48
  const louverW = radius * 1.85
  const louverCount = 6
  for (let l = 0; l < louverCount; l++) {
    const ly = louverY + l * (radius * 0.22)
    const openWave = 0.5 + 0.5 * Math.sin(t * 2.4 - l * 0.55)
    const slatH = Math.max(2.5, radius * 0.16 * openWave)

    ctx.fillStyle = `rgba(16, 185, 129, ${(1 - openWave) * 0.42})`
    ctx.fillRect(-louverW * 0.5, ly - 5, louverW, 10)

    const slatGrad = ctx.createLinearGradient(0, ly - slatH, 0, ly + slatH)
    slatGrad.addColorStop(0, '#cbd5e1')
    slatGrad.addColorStop(0.5, '#475569')
    slatGrad.addColorStop(1, '#0f172a')
    ctx.fillStyle = slatGrad
    ctx.beginPath()
    ctx.roundRect(-louverW * 0.5, ly - slatH * 0.5, louverW, slatH, 2)
    ctx.fill()
  }

  ctx.restore()
}

function drawCamActuatorAndSpring(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  scale: number,
  phase: number,
) {
  ctx.save()
  ctx.translate(x, y)

  const camAngle = phase * 1.4
  const lift = 0.5 + 0.5 * Math.sin(camAngle)
  const rockerAngle = -0.28 + lift * 0.46

  ctx.save()
  ctx.rotate(camAngle)
  const camGrad = ctx.createLinearGradient(-40 * scale, -40 * scale, 40 * scale, 40 * scale)
  camGrad.addColorStop(0, '#78350f')
  camGrad.addColorStop(0.5, '#fbbf24')
  camGrad.addColorStop(1, '#451a03')
  ctx.fillStyle = camGrad
  ctx.beginPath()
  ctx.arc(14 * scale, 0, 32 * scale, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = 'rgba(254, 243, 199, 0.5)'
  ctx.lineWidth = 1.5
  ctx.stroke()

  ctx.fillStyle = '#0f172a'
  ctx.beginPath()
  ctx.arc(0, 0, 8 * scale, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()

  const pivotX = -65 * scale
  const pivotY = -58 * scale
  const armLen = 135 * scale
  const tipX = pivotX + Math.cos(rockerAngle) * armLen
  const tipY = pivotY + Math.sin(rockerAngle) * armLen

  const springAnchorX = pivotX + armLen * 0.88
  const springAnchorY = 58 * scale
  const coils = 9
  ctx.strokeStyle = '#cbd5e1'
  ctx.lineWidth = 3.2 * scale
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  ctx.moveTo(springAnchorX, springAnchorY)
  for (let c = 1; c <= coils; c++) {
    const u = c / (coils + 1)
    const sx = springAnchorX + (tipX - springAnchorX) * u + (c % 2 === 0 ? 13 : -13) * scale
    const sy = springAnchorY + (tipY - springAnchorY) * u
    ctx.lineTo(sx, sy)
  }
  ctx.lineTo(tipX, tipY)
  ctx.stroke()

  ctx.strokeStyle = '#94a3b8'
  ctx.lineWidth = 12 * scale
  ctx.beginPath()
  ctx.moveTo(pivotX, pivotY)
  ctx.lineTo(tipX, tipY)
  ctx.stroke()

  ctx.strokeStyle = '#1e293b'
  ctx.lineWidth = 5 * scale
  ctx.stroke()

  for (const [bx, by] of [
    [pivotX, pivotY],
    [tipX, tipY],
    [springAnchorX, springAnchorY],
  ] as const) {
    ctx.fillStyle = '#e2e8f0'
    ctx.beginPath()
    ctx.arc(bx, by, 7 * scale, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#0f172a'
    ctx.beginPath()
    ctx.arc(bx, by, 3 * scale, 0, Math.PI * 2)
    ctx.fill()
  }

  ctx.restore()
}

function drawLinearRackAndPinion(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  scale: number,
  phase: number,
) {
  ctx.save()
  ctx.translate(x, y)

  const trackW = 340 * scale
  const slideOffset = Math.sin(phase * 0.9) * (82 * scale)
  const pinionAngle = slideOffset / (26 * scale)

  ctx.strokeStyle = '#64748b'
  ctx.lineWidth = 4 * scale
  ctx.beginPath()
  ctx.moveTo(-trackW * 0.5, -14 * scale)
  ctx.lineTo(trackW * 0.5, -14 * scale)
  ctx.moveTo(-trackW * 0.5, 14 * scale)
  ctx.lineTo(trackW * 0.5, 14 * scale)
  ctx.stroke()

  ctx.save()
  ctx.translate(slideOffset, 0)
  const rackW = 170 * scale
  ctx.fillStyle = '#334155'
  ctx.beginPath()
  ctx.roundRect(-rackW * 0.5, -8 * scale, rackW, 20 * scale, 4 * scale)
  ctx.fill()
  ctx.strokeStyle = '#94a3b8'
  ctx.lineWidth = 1.2
  ctx.stroke()

  const toothPitch = 10 * scale
  ctx.fillStyle = '#cbd5e1'
  for (let tx = -rackW * 0.44; tx <= rackW * 0.44; tx += toothPitch) {
    ctx.beginPath()
    ctx.moveTo(tx - 3 * scale, -8 * scale)
    ctx.lineTo(tx - 1.8 * scale, -14 * scale)
    ctx.lineTo(tx + 1.8 * scale, -14 * scale)
    ctx.lineTo(tx + 3 * scale, -8 * scale)
    ctx.closePath()
    ctx.fill()
  }

  ctx.fillStyle = '#10b981'
  ctx.beginPath()
  ctx.arc(0, 2 * scale, 4 * scale, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()

  drawPrecisionGear(ctx, 0, -39 * scale, 25 * scale, 14, pinionAngle, 'steel', 4, 0.25)

  ctx.restore()
}

function drawHexBolt(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.save()
  ctx.translate(x, y)

  ctx.fillStyle = '#090d16'
  ctx.beginPath()
  ctx.arc(0, 0, r * 1.25, 0, Math.PI * 2)
  ctx.fill()

  const headGrad = ctx.createLinearGradient(-r, -r, r, r)
  headGrad.addColorStop(0, '#e2e8f0')
  headGrad.addColorStop(0.5, '#64748b')
  headGrad.addColorStop(1, '#1e293b')
  ctx.fillStyle = headGrad
  ctx.beginPath()
  ctx.arc(0, 0, r, 0, Math.PI * 2)
  ctx.fill()

  ctx.fillStyle = '#0f172a'
  ctx.beginPath()
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6
    const hx = Math.cos(a) * (r * 0.52)
    const hy = Math.sin(a) * (r * 0.52)
    if (i === 0) ctx.moveTo(hx, hy)
    else ctx.lineTo(hx, hy)
  }
  ctx.closePath()
  ctx.fill()

  ctx.restore()
}

function drawBrushedArmorPlates(
  ctx: CanvasRenderingContext2D,
  splitX: number,
  w: number,
  h: number,
  scale: number,
  speedMult: number,
) {
  const mechW = w - splitX
  const plateDepth = Math.min(68 * scale, mechW * 0.14)

  ctx.save()

  const plateGrad = ctx.createLinearGradient(splitX, 0, w, h)
  plateGrad.addColorStop(0, '#1e2636')
  plateGrad.addColorStop(0.35, '#2b3648')
  plateGrad.addColorStop(0.55, '#3b4961')
  plateGrad.addColorStop(0.8, '#232d3d')
  plateGrad.addColorStop(1, '#151c28')

  ctx.fillStyle = plateGrad
  ctx.strokeStyle = 'rgba(226, 232, 240, 0.25)'
  ctx.lineWidth = 1.5

  // Top armor plate
  ctx.beginPath()
  ctx.moveTo(splitX, 0)
  ctx.lineTo(w, 0)
  ctx.lineTo(w, plateDepth * 1.15)
  ctx.lineTo(w - plateDepth * 0.5, plateDepth * 1.15)
  ctx.lineTo(w - plateDepth * 0.85, plateDepth * 0.72)
  ctx.lineTo(splitX + plateDepth * 1.2, plateDepth * 0.72)
  ctx.lineTo(splitX + plateDepth * 0.75, plateDepth * 1.18)
  ctx.lineTo(splitX, plateDepth * 1.18)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()

  // Bottom armor plate
  ctx.beginPath()
  ctx.moveTo(splitX, h)
  ctx.lineTo(w, h)
  ctx.lineTo(w, h - plateDepth * 1.1)
  ctx.lineTo(w - plateDepth * 0.9, h - plateDepth * 1.1)
  ctx.lineTo(w - plateDepth * 1.3, h - plateDepth * 0.65)
  ctx.lineTo(splitX + plateDepth * 1.3, h - plateDepth * 0.65)
  ctx.lineTo(splitX + plateDepth * 0.85, h - plateDepth * 1.12)
  ctx.lineTo(splitX, h - plateDepth * 1.12)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()

  // Right outer edge armor rail
  ctx.beginPath()
  ctx.moveTo(w, plateDepth * 1.15)
  ctx.lineTo(w - plateDepth * 0.65, plateDepth * 1.45)
  ctx.lineTo(w - plateDepth * 0.65, h - plateDepth * 1.45)
  ctx.lineTo(w, h - plateDepth * 1.1)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()

  const boltR = Math.max(4.5, 6.5 * scale)
  const boltCoords: [number, number][] = [
    [splitX + 26, 24],
    [splitX + mechW * 0.34, 22],
    [splitX + mechW * 0.68, 22],
    [w - 26, 24],
    [splitX + 26, h - 24],
    [splitX + mechW * 0.34, h - 22],
    [splitX + mechW * 0.68, h - 22],
    [w - 26, h - 24],
    [w - 20, h * 0.35],
    [w - 20, h * 0.65],
  ]
  for (const [bx, by] of boltCoords) {
    if (bx > splitX + 12) {
      drawHexBolt(ctx, bx, by, boltR)
    }
  }

  if (mechW > 220) {
    ctx.fillStyle = 'rgba(148, 163, 184, 0.55)'
    ctx.font = `600 ${Math.round(10 * Math.max(0.85, scale))}px "JetBrains Mono", monospace`
    const rpm = Math.round(42 * speedMult)
    ctx.fillText(`MECH-CORE // SYS-02`, splitX + 52, 26)
    ctx.fillText(`SYNC ${rpm} RPM`, w - 138, 26)
  }

  ctx.restore()
}

// ─────────────────────────────────────────────────────────────────────────────
// CENTRAL BIOMECHANICAL SEAM (WHERE ORGANIC ROOTS & VINES MEET METAL GEARS)
// ─────────────────────────────────────────────────────────────────────────────
function drawBiomechanicalSeam(
  ctx: CanvasRenderingContext2D,
  h: number,
  splitX: number,
  t: number,
) {
  ctx.save()

  const bevelGrad = ctx.createLinearGradient(splitX - 6, 0, splitX + 18, 0)
  bevelGrad.addColorStop(0, 'rgba(6, 24, 14, 0.75)')
  bevelGrad.addColorStop(0.35, '#94a3b8')
  bevelGrad.addColorStop(0.65, '#334155')
  bevelGrad.addColorStop(1, 'rgba(15, 23, 42, 0)')

  ctx.fillStyle = bevelGrad
  ctx.fillRect(splitX - 3, 0, 18, h)

  ctx.strokeStyle = 'rgba(52, 211, 153, 0.65)'
  ctx.lineWidth = 1.6
  ctx.shadowColor = 'rgba(16, 185, 129, 0.8)'
  ctx.shadowBlur = 12
  ctx.beginPath()
  ctx.moveTo(splitX, 0)
  ctx.lineTo(splitX, h)
  ctx.stroke()
  ctx.shadowBlur = 0

  for (const vine of seamVines) {
    const baseY = vine.yNorm * h
    const sway = Math.sin(t * 1.4 + vine.curveSeed) * 6
    const startX = splitX - 28
    const endX = splitX + vine.reachRight
    const endY = baseY + Math.sin(vine.curveSeed) * 34 + sway
    const ctrlX = splitX + vine.reachRight * 0.35
    const ctrlY = baseY - 18 + sway * 0.6

    ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)'
    ctx.lineWidth = 4.2
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(startX, baseY + 3)
    ctx.quadraticCurveTo(ctrlX + 2, ctrlY + 4, endX + 2, endY + 4)
    ctx.stroke()

    ctx.strokeStyle = '#15803d'
    ctx.lineWidth = 3.2
    ctx.beginPath()
    ctx.moveTo(startX, baseY)
    ctx.quadraticCurveTo(ctrlX, ctrlY, endX, endY)
    ctx.stroke()

    for (let l = 1; l <= vine.leafCount; l++) {
      const u = l / (vine.leafCount + 1)
      const inv = 1 - u
      const lx = inv * inv * startX + 2 * inv * u * ctrlX + u * u * endX
      const ly = inv * inv * baseY + 2 * inv * u * ctrlY + u * u * endY
      const side = l % 2 === 0 ? 1 : -1
      const leafAngle = side * 0.85 + Math.sin(t * 1.9 + l + vine.curveSeed) * 0.12

      ctx.save()
      ctx.translate(lx, ly)
      ctx.rotate(leafAngle)
      ctx.fillStyle = l % 2 === 0 ? '#4ade80' : '#22c55e'
      ctx.beginPath()
      ctx.ellipse(6, 0, 7.5, 3.8, 0, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    }
  }

  ctx.restore()
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ANIMATION LOOP
// ─────────────────────────────────────────────────────────────────────────────
function renderFrame(now: number) {
  const canvas = canvasEl.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  if (!startTime) {
    startTime = now
    lastFrameTime = now
  }

  const dt = Math.min(0.05, Math.max(0.001, (now - lastFrameTime) * 0.001))
  lastFrameTime = now
  const elapsed = reducedMotion ? 0 : (now - startTime) * 0.001

  splitRatio.value += (targetSplitRatio - splitRatio.value) * 0.14

  pointer.vx *= 0.86
  pointer.vy *= 0.86

  const targetSpeed =
    pointer.active && pointer.x > splitRatio.value
      ? 1.55 + Math.min(0.85, Math.hypot(pointer.vx, pointer.vy) * 0.04)
      : 1.0
  mechSpeedMultiplier += (targetSpeed - mechSpeedMultiplier) * 0.08
  if (!reducedMotion) {
    mechPhase += dt * mechSpeedMultiplier
  }

  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const w = canvas.width / dpr
  const h = canvas.height / dpr
  const splitX = w * splitRatio.value

  ctx.save()
  ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, w, h)

  // 1. Render Right Metallic & Mechanical Moving World
  drawMetallicWorld(ctx, w, h, splitX, elapsed, dt)

  // 2. Render Left Organic World + Central Biomechanical Seam + Overlapping Foreground Grass
  drawOrganicWorld(ctx, w, h, splitX, elapsed, dt)

  ctx.restore()

  if (!reducedMotion) {
    rafId = window.requestAnimationFrame(renderFrame)
  }
}

function syncCanvasSize() {
  const canvas = canvasEl.value
  if (!canvas) return
  const rect = canvas.getBoundingClientRect()
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  canvas.width = Math.max(1, Math.round(rect.width * dpr))
  canvas.height = Math.max(1, Math.round(rect.height * dpr))
}

onMounted(() => {
  if (typeof window === 'undefined') return
  reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  initEcosystem()
  syncCanvasSize()

  if (typeof ResizeObserver !== 'undefined' && canvasEl.value) {
    resizeObserver = new ResizeObserver(() => {
      syncCanvasSize()
      if (reducedMotion) renderFrame(performance.now())
    })
    resizeObserver.observe(canvasEl.value)
  }

  rafId = window.requestAnimationFrame(renderFrame)
})

onUnmounted(() => {
  if (rafId && typeof window !== 'undefined') {
    window.cancelAnimationFrame(rafId)
  }
  resizeObserver?.disconnect()
})
</script>

<style scoped>
.biomech-stage {
  position: relative;
  width: 100vw;
  height: 100vh;
  min-height: 560px;
  padding: 16px;
  background: #040706;
  overflow: hidden;
  user-select: none;
}

.biomech-panel-frame {
  position: relative;
  width: 100%;
  height: 100%;
  border-radius: 26px;
  overflow: hidden;
  box-shadow:
    0 30px 90px rgba(0, 0, 0, 0.85),
    inset 0 1px 0 rgba(255, 255, 255, 0.16),
    inset 0 0 0 1px rgba(255, 255, 255, 0.08);
}

.biomech-canvas {
  display: block;
  width: 100%;
  height: 100%;
}

.biomech-seam-hit {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 36px;
  transform: translateX(-50%);
  cursor: ew-resize;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 5;
}

.biomech-seam-node {
  position: relative;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: rgba(10, 18, 16, 0.78);
  border: 1.5px solid rgba(110, 231, 183, 0.65);
  box-shadow:
    0 0 24px rgba(16, 185, 129, 0.45),
    inset 0 1px 0 rgba(255, 255, 255, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  transition: transform 220ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 220ms ease;
}

.biomech-seam-hit:hover .biomech-seam-node {
  transform: scale(1.14);
  box-shadow:
    0 0 32px rgba(52, 211, 153, 0.75),
    inset 0 1px 0 rgba(255, 255, 255, 0.5);
}

.seam-node-ring {
  position: absolute;
  inset: 4px;
  border-radius: 50%;
  border: 1px dashed rgba(203, 213, 225, 0.55);
  animation: seamRingSpin 10s linear infinite;
}

.seam-node-core {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: linear-gradient(90deg, #4ade80 0%, #e2e8f0 100%);
  box-shadow: 0 0 10px rgba(74, 222, 128, 0.85);
}

@keyframes seamRingSpin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 768px) {
  .biomech-stage {
    padding: 8px;
  }

  .biomech-panel-frame {
    border-radius: 18px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .seam-node-ring {
    animation: none;
  }
}
</style>
