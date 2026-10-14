<template>
  <section
    ref="panelRoot"
    class="biomech-stage"
    aria-label="Half artistic organic grass and half matte-white mechanical panel"
    @pointermove="onPointerMove"
    @pointerleave="onPointerLeave"
  >
    <canvas ref="canvasEl" class="biomech-canvas" />
  </section>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'

const panelRoot = ref<HTMLElement | null>(null)
const canvasEl = ref<HTMLCanvasElement | null>(null)

const pointer = {
  x: 0.5,
  y: 0.5,
  px: -9999,
  py: -9999,
  vx: 0,
  vy: 0,
  lastPx: 0,
  lastPy: 0,
  active: false,
}

interface ArtisticGrassBlade {
  cluster: 'left' | 'seam'
  baseXOffset: number // px offset relative to cluster anchor
  heightRatio: number // fraction of viewport height
  baseWidth: number
  archDir: number // -1 left, +1 right
  archAmount: number // horizontal sweep ratio
  midControlBias: number
  tipCurl: number
  twistAt: number // 0 = no twist, 0.45..0.75 = subtle botanical ribbon twist
  tone: 'deep-sage' | 'mid-olive' | 'soft-sage' | 'pale-moss'
  opacity: number
  swaySpeed: number
  swayPhase: number
  currentBend: number
  bendVelocity: number
}

const blades: ArtisticGrassBlade[] = [
  // ── Left Bottom Corner Cluster (sparse, delicate architectural strokes) ──
  {
    cluster: 'left',
    baseXOffset: -18,
    heightRatio: 0.22,
    baseWidth: 4.2,
    archDir: -1,
    archAmount: 0.52,
    midControlBias: 0.25,
    tipCurl: -0.18,
    twistAt: 0.58,
    tone: 'mid-olive',
    opacity: 0.92,
    swaySpeed: 0.72,
    swayPhase: 0.4,
    currentBend: 0,
    bendVelocity: 0,
  },
  {
    cluster: 'left',
    baseXOffset: 2,
    heightRatio: 0.19,
    baseWidth: 3.4,
    archDir: 1,
    archAmount: 0.48,
    midControlBias: 0.18,
    tipCurl: 0.22,
    twistAt: 0,
    tone: 'soft-sage',
    opacity: 0.85,
    swaySpeed: 0.84,
    swayPhase: 1.7,
    currentBend: 0,
    bendVelocity: 0,
  },
  {
    cluster: 'left',
    baseXOffset: 22,
    heightRatio: 0.24,
    baseWidth: 4.8,
    archDir: -1,
    archAmount: 0.36,
    midControlBias: 0.14,
    tipCurl: -0.15,
    twistAt: 0.62,
    tone: 'deep-sage',
    opacity: 0.96,
    swaySpeed: 0.68,
    swayPhase: 2.9,
    currentBend: 0,
    bendVelocity: 0,
  },
  {
    cluster: 'left',
    baseXOffset: 44,
    heightRatio: 0.18,
    baseWidth: 3.2,
    archDir: -1,
    archAmount: 0.22,
    midControlBias: 0.08,
    tipCurl: -0.08,
    twistAt: 0,
    tone: 'mid-olive',
    opacity: 0.88,
    swaySpeed: 0.9,
    swayPhase: 4.1,
    currentBend: 0,
    bendVelocity: 0,
  },
  {
    cluster: 'left',
    baseXOffset: 62,
    heightRatio: 0.11,
    baseWidth: 2.5,
    archDir: 1,
    archAmount: 0.54,
    midControlBias: 0.28,
    tipCurl: 0.16,
    twistAt: 0,
    tone: 'pale-moss',
    opacity: 0.78,
    swaySpeed: 0.95,
    swayPhase: 5.2,
    currentBend: 0,
    bendVelocity: 0,
  },

  // ── Central Seam Cluster (tall, lyrical calligraphic blades rising beside the white chassis) ──
  {
    cluster: 'seam',
    baseXOffset: -36,
    heightRatio: 0.14,
    baseWidth: 3.0,
    archDir: -1,
    archAmount: 0.88,
    midControlBias: 0.42,
    tipCurl: -0.35,
    twistAt: 0,
    tone: 'pale-moss',
    opacity: 0.75,
    swaySpeed: 0.82,
    swayPhase: 0.2,
    currentBend: 0,
    bendVelocity: 0,
  },
  {
    cluster: 'seam',
    baseXOffset: -26,
    heightRatio: 0.26,
    baseWidth: 4.4,
    archDir: -1,
    archAmount: 0.68,
    midControlBias: 0.34,
    tipCurl: -0.28,
    twistAt: 0.54,
    tone: 'soft-sage',
    opacity: 0.88,
    swaySpeed: 0.74,
    swayPhase: 1.1,
    currentBend: 0,
    bendVelocity: 0,
  },
  {
    cluster: 'seam',
    baseXOffset: -18,
    heightRatio: 0.35,
    baseWidth: 5.2,
    archDir: -1,
    archAmount: 0.54,
    midControlBias: 0.26,
    tipCurl: -0.22,
    twistAt: 0.6,
    tone: 'mid-olive',
    opacity: 0.94,
    swaySpeed: 0.66,
    swayPhase: 2.3,
    currentBend: 0,
    bendVelocity: 0,
  },
  {
    cluster: 'seam',
    baseXOffset: -12,
    heightRatio: 0.48,
    baseWidth: 5.5,
    archDir: -1,
    archAmount: 0.32,
    midControlBias: 0.15,
    tipCurl: -0.18,
    twistAt: 0.66,
    tone: 'deep-sage',
    opacity: 0.97,
    swaySpeed: 0.58,
    swayPhase: 3.4,
    currentBend: 0,
    bendVelocity: 0,
  },
  {
    cluster: 'seam',
    baseXOffset: -6,
    heightRatio: 0.62,
    baseWidth: 4.6,
    archDir: -1,
    archAmount: 0.16,
    midControlBias: 0.05,
    tipCurl: -0.14,
    twistAt: 0.7,
    tone: 'mid-olive',
    opacity: 0.92,
    swaySpeed: 0.52,
    swayPhase: 4.6,
    currentBend: 0,
    bendVelocity: 0,
  },
  {
    cluster: 'seam',
    baseXOffset: -2,
    heightRatio: 0.42,
    baseWidth: 3.8,
    archDir: 1,
    archAmount: 0.11,
    midControlBias: 0.04,
    tipCurl: -0.09,
    twistAt: 0,
    tone: 'soft-sage',
    opacity: 0.86,
    swaySpeed: 0.64,
    swayPhase: 5.5,
    currentBend: 0,
    bendVelocity: 0,
  },
  {
    cluster: 'seam',
    baseXOffset: 3,
    heightRatio: 0.29,
    baseWidth: 3.6,
    archDir: 1,
    archAmount: 0.22,
    midControlBias: 0.12,
    tipCurl: 0.14,
    twistAt: 0.55,
    tone: 'deep-sage',
    opacity: 0.9,
    swaySpeed: 0.76,
    swayPhase: 0.9,
    currentBend: 0,
    bendVelocity: 0,
  },
  {
    cluster: 'seam',
    baseXOffset: 8,
    heightRatio: 0.18,
    baseWidth: 2.8,
    archDir: 1,
    archAmount: 0.34,
    midControlBias: 0.18,
    tipCurl: 0.18,
    twistAt: 0,
    tone: 'pale-moss',
    opacity: 0.82,
    swaySpeed: 0.88,
    swayPhase: 2.0,
    currentBend: 0,
    bendVelocity: 0,
  },
]

let rafId = 0
let resizeObserver: ResizeObserver | null = null
let reducedMotion = false
let startTime = 0
let lastFrameTime = 0
let mechPhase = 0

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
}

function onPointerLeave() {
  pointer.active = false
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. LEFT SIDE: SERENE ALABASTER CANVAS & ARTISTIC HAND-DRAWN GRASS
// ─────────────────────────────────────────────────────────────────────────────
function drawLeftOrganicCanvas(ctx: CanvasRenderingContext2D, splitX: number, h: number) {
  // Warm editorial ivory/alabaster paper wash
  const bgGrad = ctx.createLinearGradient(0, 0, splitX, h)
  bgGrad.addColorStop(0, '#fdfdfb')
  bgGrad.addColorStop(0.65, '#fafaf7')
  bgGrad.addColorStop(1, '#f3f5f0')
  ctx.fillStyle = bgGrad
  ctx.fillRect(0, 0, splitX, h)

  // Subtle ambient shadow cast leftward by the central vertical mechanical wall
  const wallShadow = ctx.createLinearGradient(splitX - 54, 0, splitX, 0)
  wallShadow.addColorStop(0, 'rgba(148, 163, 156, 0)')
  wallShadow.addColorStop(0.7, 'rgba(148, 163, 156, 0.06)')
  wallShadow.addColorStop(1, 'rgba(100, 116, 109, 0.16)')
  ctx.fillStyle = wallShadow
  ctx.fillRect(splitX - 54, 0, 54, h)
}

function evaluateCubicPoint(
  t: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
): [number, number] {
  const inv = 1 - t
  const b0 = inv * inv * inv
  const b1 = 3 * inv * inv * t
  const b2 = 3 * inv * t * t
  const b3 = t * t * t
  return [
    b0 * x0 + b1 * x1 + b2 * x2 + b3 * x3,
    b0 * y0 + b1 * y1 + b2 * y2 + b3 * y3,
  ]
}

function evaluateCubicTangent(
  t: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
): [number, number] {
  const inv = 1 - t
  const d0 = 3 * inv * inv
  const d1 = 6 * inv * t
  const d2 = 3 * t * t
  const tx = d0 * (x1 - x0) + d1 * (x2 - x1) + d2 * (x3 - x2)
  const ty = d0 * (y1 - y0) + d1 * (y2 - y1) + d2 * (y3 - y2)
  const len = Math.max(1e-4, Math.hypot(tx, ty))
  return [tx / len, ty / len]
}

function drawArtisticGrassBlades(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  splitX: number,
  t: number,
  dt: number,
) {
  const leftClusterAnchorX = Math.max(42, splitX * 0.11)
  const seamClusterAnchorX = splitX - 8

  for (const blade of blades) {
    const anchorX = blade.cluster === 'left' ? leftClusterAnchorX : seamClusterAnchorX
    const x0 = anchorX + blade.baseXOffset
    const y0 = h + 4
    const bladeH = blade.heightRatio * h

    // Gentle poetic breeze
    const breeze =
      Math.sin(t * blade.swaySpeed + blade.swayPhase) * 0.045 +
      Math.cos(t * (blade.swaySpeed * 0.6) + blade.swayPhase * 1.4) * 0.02

    let targetBend = breeze

    // Subtle cursor brush interaction
    if (pointer.active) {
      const sampleX = x0 + blade.archDir * bladeH * blade.archAmount * 0.45
      const sampleY = y0 - bladeH * 0.55
      const dx = sampleX - pointer.px
      const dy = sampleY - pointer.py
      const dist = Math.hypot(dx, dy)
      if (dist < 160) {
        const push = Math.pow(1 - dist / 160, 1.8)
        targetBend += (dx >= 0 ? 0.16 : -0.16) * push + pointer.vx * 0.0025 * push
      }
    }

    // Smooth damped spring
    const accel = (targetBend - blade.currentBend) * 9.5
    blade.bendVelocity = (blade.bendVelocity + accel * dt) * 0.86
    blade.currentBend += blade.bendVelocity

    const totalArch = blade.archDir * blade.archAmount + blade.currentBend
    const x1 = x0 + totalArch * bladeH * blade.midControlBias
    const y1 = y0 - bladeH * 0.36
    const x2 = x0 + totalArch * bladeH * 0.68
    const y2 = y0 - bladeH * 0.78
    const x3 = x0 + totalArch * bladeH + blade.tipCurl * bladeH * 0.42
    const y3 = y0 - bladeH + Math.abs( totalArch ) * bladeH * 0.18

    // Sample ribbon polygon along the cubic bezier spine
    const segments = 32
    const leftPts: [number, number][] = []
    const rightPts: [number, number][] = []
    const spinePts: [number, number][] = []

    for (let i = 0; i <= segments; i++) {
      const u = i / segments
      const [px, py] = evaluateCubicPoint(u, x0, y0, x1, y1, x2, y2, x3, y3)
      const [tx, ty] = evaluateCubicTangent(u, x0, y0, x1, y1, x2, y2, x3, y3)
      const nx = -ty
      const ny = tx

      // Botanical taper profile: swells slightly above base, then tapers to a razor-sharp tip
      let taper = Math.pow(1 - u, 0.82) * (0.85 + 0.25 * Math.sin(u * Math.PI))
      if (blade.twistAt > 0) {
        // Subtle 3D leaf ribbon twist pinch
        const twistDist = Math.abs(u - blade.twistAt)
        if (twistDist < 0.16) {
          taper *= 0.38 + 0.62 * (twistDist / 0.16)
        }
      }

      const halfW = blade.baseWidth * taper
      leftPts.push([px + nx * halfW, py + ny * halfW])
      rightPts.push([px - nx * halfW, py - ny * halfW])
      spinePts.push([px, py])
    }

    ctx.save()
    ctx.globalAlpha = blade.opacity

    // Painterly botanical watercolor/ink gradient along the blade
    const grad = ctx.createLinearGradient(x0, y0, x3, y3)
    if (blade.tone === 'deep-sage') {
      grad.addColorStop(0, '#44633b')
      grad.addColorStop(0.55, '#648757')
      grad.addColorStop(1, '#8eab80')
    } else if (blade.tone === 'mid-olive') {
      grad.addColorStop(0, '#557549')
      grad.addColorStop(0.5, '#789a6a')
      grad.addColorStop(1, '#a4be96')
    } else if (blade.tone === 'soft-sage') {
      grad.addColorStop(0, '#68895c')
      grad.addColorStop(0.55, '#8bab7d')
      grad.addColorStop(1, '#b6cca9')
    } else {
      grad.addColorStop(0, '#7c9c70')
      grad.addColorStop(0.6, '#9cb98f')
      grad.addColorStop(1, '#c5d7ba')
    }

    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.moveTo(leftPts[0][0], leftPts[0][1])
    for (let i = 1; i <= segments; i++) {
      ctx.lineTo(leftPts[i][0], leftPts[i][1])
    }
    for (let i = segments; i >= 0; i--) {
      ctx.lineTo(rightPts[i][0], rightPts[i][1])
    }
    ctx.closePath()
    ctx.fill()

    // Delicate hand-drawn botanical ink edge & center midrib vein
    ctx.strokeStyle = 'rgba(54, 78, 45, 0.42)'
    ctx.lineWidth = 0.75
    ctx.beginPath()
    ctx.moveTo(leftPts[0][0], leftPts[0][1])
    for (let i = 1; i <= segments; i++) {
      ctx.lineTo(leftPts[i][0], leftPts[i][1])
    }
    ctx.stroke()

    // Fine pale midrib highlight line along the spine
    ctx.strokeStyle = 'rgba(242, 247, 238, 0.55)'
    ctx.lineWidth = 0.65
    ctx.beginPath()
    ctx.moveTo(spinePts[0][0], spinePts[0][1])
    for (let i = 1; i <= Math.floor(segments * 0.82); i++) {
      ctx.lineTo(spinePts[i][0], spinePts[i][1])
    }
    ctx.stroke()

    ctx.restore()
  }

  void w
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. RIGHT SIDE: CLEAN MATTE-WHITE & SILVER MECHANICAL PANEL (LESS BUSY)
// ─────────────────────────────────────────────────────────────────────────────
function drawRightMechanicalPanel(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  splitX: number,
  phase: number,
) {
  const wallW = Math.max(36, Math.min(54, w * 0.036))
  const bayX = splitX + wallW
  const bayW = Math.max(1, w - bayX)
  const s = Math.min(bayW / 680, h / 780)

  ctx.save()

  // ── A. Recessed Machined Satin-Alabaster / Anodized Silver Backplate ──
  const trayGrad = ctx.createLinearGradient(bayX, 0, w, h)
  trayGrad.addColorStop(0, '#d2dad7')
  trayGrad.addColorStop(0.5, '#dce3e0')
  trayGrad.addColorStop(1, '#c9d2cf')
  ctx.fillStyle = trayGrad
  ctx.fillRect(bayX, 0, bayW, h)

  // Subtle recessed architectural panel seams in the backplate
  ctx.strokeStyle = 'rgba(100, 114, 110, 0.18)'
  ctx.lineWidth = 1
  const pad = 24 * s
  ctx.strokeRect(bayX + pad, pad, bayW - pad * 2, h - pad * 2)

  // ── B. Clean Parallel Sage-Green Conduit Ribbons (Background Bus) ──
  drawSageConduitRibbons(ctx, bayX, bayW, h, s, phase)

  // ── C. 1. Upper-Left Horizontal Brushed-Metal Roller / Damper Cylinder ──
  drawUpperRollerCylinder(ctx, bayX + bayW * 0.25, h * 0.125, s, phase)

  // ── D. 2. Upper-Right Clean Matte-White Manifold Module ──
  drawMatteWhiteModule(
    ctx,
    bayX + bayW * 0.53,
    h * 0.035,
    bayW * 0.42,
    h * 0.175,
    s,
    true,
  )

  // ── E. 3. Lower-Left & Mid-Right Clean Matte-White Manifold Modules ──
  drawMatteWhiteModule(
    ctx,
    bayX + bayW * 0.045,
    h * 0.74,
    bayW * 0.17,
    h * 0.12,
    s,
    false,
  )
  drawMatteWhiteModule(
    ctx,
    bayX + bayW * 0.255,
    h * 0.73,
    bayW * 0.23,
    h * 0.135,
    s,
    false,
  )
  drawMatteWhiteModule(
    ctx,
    bayX + bayW * 0.79,
    h * 0.48,
    bayW * 0.18,
    h * 0.19,
    s,
    false,
  )

  // ── F. 4. Lower-Left Horizontal Sage-Fluid Damper Capsule ──
  drawLowerFluidDamper(ctx, bayX + bayW * 0.15, h * 0.915, s, phase)

  // ── G. 5. ICONIC CENTERPIECE: Large Matte-White Rotary Hub + Articulated Dual-Link Arm & Telescopic Piston ──
  drawCentralArticulatedMechanism(ctx, bayX, bayW, h, s, phase)

  // ── H. Sculpted Matte-White Vertical Divider Bulkhead (with Stepped Sage Notch) ──
  drawSteppedDividerBulkhead(ctx, splitX, wallW, w, h, s)

  // ── I. Flush Protective Glass Cover Plate & Diagonal Specular Reflections ──
  drawGlassCoverReflections(ctx, bayX, bayW, h, s)

  ctx.restore()
}

function drawSageConduitRibbons(
  ctx: CanvasRenderingContext2D,
  bayX: number,
  bayW: number,
  h: number,
  s: number,
  phase: number,
) {
  ctx.save()

  // Neat parallel 4-line sage-green conduit tracks like the reference image
  const trackOffsets = [-9, -3, 3, 9].map((o) => o * s)

  // Ribbon Group 1: From under the Upper-Right Module curving into the mid bay
  for (let i = 0; i < trackOffsets.length; i++) {
    const off = trackOffsets[i]
    const sx = bayX + bayW * 0.56 + off
    const sy = h * 0.19
    const turnY = h * 0.265 + off
    const ex = bayX + bayW * 0.82

    ctx.strokeStyle = i % 2 === 0 ? '#749468' : '#8fad82'
    ctx.lineWidth = 3.2 * s
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.moveTo(sx, sy)
    ctx.lineTo(sx, turnY - 14 * s)
    ctx.quadraticCurveTo(sx, turnY, sx + 14 * s, turnY)
    ctx.lineTo(ex, turnY)
    ctx.stroke()
  }

  // Ribbon Group 2: Below the Main Rotary Hub sweeping right and down
  for (let i = 0; i < trackOffsets.length; i++) {
    const off = trackOffsets[i]
    const sx = bayX + bayW * 0.19 + off
    const sy = h * 0.55
    const turnY = h * 0.675 + off
    const turnX = bayX + bayW * 0.66 + off
    const ey = h * 0.88

    ctx.strokeStyle = i % 2 === 0 ? '#749468' : '#94b088'
    ctx.lineWidth = 3.2 * s
    ctx.beginPath()
    ctx.moveTo(sx, sy)
    ctx.lineTo(sx, turnY - 16 * s)
    ctx.quadraticCurveTo(sx, turnY, sx + 16 * s, turnY)
    ctx.lineTo(turnX - 16 * s, turnY)
    ctx.quadraticCurveTo(turnX, turnY, turnX, turnY + 16 * s)
    ctx.lineTo(turnX, ey)
    ctx.stroke()

    // Subtle moving sage-mint telemetry pulse along the middle track
    if (i === 1) {
      const p = (phase * 0.28) % 1
      const pulseX = sx + p * (turnX - sx)
      const grad = ctx.createRadialGradient(pulseX, turnY, 1, pulseX, turnY, 16 * s)
      grad.addColorStop(0, 'rgba(182, 218, 168, 0.85)')
      grad.addColorStop(1, 'rgba(182, 218, 168, 0)')
      ctx.fillStyle = grad
      ctx.beginPath()
      ctx.arc(pulseX, turnY, 16 * s, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  ctx.restore()
}

function drawUpperRollerCylinder(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  s: number,
  phase: number,
) {
  ctx.save()
  ctx.translate(cx, cy)

  const totalW = 195 * s
  const cylH = 66 * s

  // Ambient shadow
  ctx.fillStyle = 'rgba(71, 85, 82, 0.22)'
  ctx.beginPath()
  ctx.roundRect(-totalW * 0.5 + 4 * s, -cylH * 0.5 + 6 * s, totalW, cylH, 10 * s)
  ctx.fill()

  // Dark brushed-steel roller barrel (right half of cylinder)
  const darkGrad = ctx.createLinearGradient(0, -cylH * 0.44, 0, cylH * 0.44)
  darkGrad.addColorStop(0, '#374146')
  darkGrad.addColorStop(0.32, '#79848a')
  darkGrad.addColorStop(0.52, '#495358')
  darkGrad.addColorStop(1, '#232a2e')
  ctx.fillStyle = darkGrad
  ctx.beginPath()
  ctx.roundRect(-12 * s, -cylH * 0.44, totalW * 0.5, cylH * 0.88, 6 * s)
  ctx.fill()

  // Matte-white left cylinder housing cap
  const whiteGrad = ctx.createLinearGradient(0, -cylH * 0.5, 0, cylH * 0.5)
  whiteGrad.addColorStop(0, '#f8faf9')
  whiteGrad.addColorStop(0.55, '#e6ecea')
  whiteGrad.addColorStop(1, '#c8d1ce')
  ctx.fillStyle = whiteGrad
  ctx.beginPath()
  ctx.roundRect(-totalW * 0.36, -cylH * 0.5, totalW * 0.34, cylH, 7 * s)
  ctx.fill()
  ctx.strokeStyle = 'rgba(148, 163, 158, 0.45)'
  ctx.lineWidth = 1
  ctx.stroke()

  // Rotating vertical knurled collar lines to show subtle continuous rotation
  ctx.save()
  ctx.beginPath()
  ctx.rect(-12 * s, -cylH * 0.44, totalW * 0.5, cylH * 0.88)
  ctx.clip()

  const stripeSpacing = 9 * s
  const offset = ((phase * 14 * s) % stripeSpacing + stripeSpacing) % stripeSpacing
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)'
  ctx.lineWidth = 1.5 * s
  for (let y = -cylH * 0.5 + offset; y <= cylH * 0.5; y += stripeSpacing) {
    ctx.beginPath()
    ctx.moveTo(-8 * s, y)
    ctx.lineTo(totalW * 0.36, y)
    ctx.stroke()
  }
  ctx.restore()

  // End shaft mounts
  ctx.fillStyle = '#aeb8b5'
  ctx.fillRect(-totalW * 0.52, -cylH * 0.22, totalW * 0.16, cylH * 0.44)
  ctx.fillRect(totalW * 0.38, -cylH * 0.22, totalW * 0.16, cylH * 0.44)

  ctx.restore()
}

function drawLowerFluidDamper(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  s: number,
  phase: number,
) {
  ctx.save()
  ctx.translate(cx, cy)

  const w = 128 * s
  const h = 48 * s

  // Sage-green glass fluid tube in the middle
  const fluidGrad = ctx.createLinearGradient(0, -h * 0.38, 0, h * 0.38)
  fluidGrad.addColorStop(0, '#6a8a5e')
  fluidGrad.addColorStop(0.4, '#a6c49a')
  fluidGrad.addColorStop(1, '#4c6942')
  ctx.fillStyle = fluidGrad
  ctx.fillRect(-w * 0.38, -h * 0.36, w * 0.76, h * 0.72)

  // Moving internal metering ring inside the sage tube
  const ringX = Math.sin(phase * 1.1) * (w * 0.16)
  ctx.fillStyle = '#e6ecea'
  ctx.fillRect(ringX - 4 * s, -h * 0.36, 8 * s, h * 0.72)

  // Brushed aluminum left & right end caps
  const capGrad = ctx.createLinearGradient(0, -h * 0.5, 0, h * 0.5)
  capGrad.addColorStop(0, '#f4f7f6')
  capGrad.addColorStop(0.5, '#d0d8d5')
  capGrad.addColorStop(1, '#98a39f')
  ctx.fillStyle = capGrad
  ctx.beginPath()
  ctx.roundRect(-w * 0.5, -h * 0.48, w * 0.22, h * 0.96, 5 * s)
  ctx.roundRect(w * 0.18, -h * 0.48, w * 0.32, h * 0.96, 5 * s)
  ctx.fill()

  ctx.restore()
}

function drawMatteWhiteModule(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  s: number,
  hasBottomPorts: boolean,
) {
  ctx.save()

  // Soft cast drop shadow
  ctx.fillStyle = 'rgba(75, 88, 84, 0.18)'
  ctx.beginPath()
  ctx.roundRect(x + 4 * s, y + 6 * s, w, h, 14 * s)
  ctx.fill()

  // Matte-white ceramic/polymer body
  const bodyGrad = ctx.createLinearGradient(x, y, x, y + h)
  bodyGrad.addColorStop(0, '#f9fbfa')
  bodyGrad.addColorStop(0.65, '#edf1ef')
  bodyGrad.addColorStop(1, '#dde3e0')
  ctx.fillStyle = bodyGrad
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, 14 * s)
  ctx.fill()

  // Subtle top specular highlight & crisp border
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)'
  ctx.lineWidth = 1.4
  ctx.stroke()
  ctx.strokeStyle = 'rgba(138, 152, 147, 0.38)'
  ctx.lineWidth = 1
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)

  // Subtle panel seam line
  ctx.strokeStyle = 'rgba(148, 163, 158, 0.32)'
  ctx.beginPath()
  ctx.moveTo(x + 14 * s, y + h * 0.72)
  ctx.lineTo(x + w - 14 * s, y + h * 0.72)
  ctx.stroke()

  // 4 corner countersunk micro-screws
  const inset = 13 * s
  for (const [bx, by] of [
    [x + inset, y + inset],
    [x + w - inset, y + inset],
    [x + inset, y + h - inset],
    [x + w - inset, y + h - inset],
  ] as const) {
    drawCountersunkScrew(ctx, bx, by, 3.8 * s)
  }

  // Optional 3 cable gland ports underneath (like the upper-right module in the reference image)
  if (hasBottomPorts) {
    for (let i = 0; i < 3; i++) {
      const px = x + 26 * s + i * 24 * s
      const py = y + h
      ctx.fillStyle = '#dfe5e3'
      ctx.strokeStyle = '#9aa6a2'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.roundRect(px, py - 2 * s, 16 * s, 22 * s, 3 * s)
      ctx.fill()
      ctx.stroke()
    }
  }

  ctx.restore()
}

function drawBearingNode(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  outerR: number,
  angle: number,
) {
  ctx.save()
  ctx.translate(x, y)

  // Outer matte-white boss
  const bossGrad = ctx.createRadialGradient(-outerR * 0.25, -outerR * 0.25, 2, 0, 0, outerR)
  bossGrad.addColorStop(0, '#fafcfb')
  bossGrad.addColorStop(0.7, '#e4eae8')
  bossGrad.addColorStop(1, '#bcc6c3')
  ctx.fillStyle = bossGrad
  ctx.beginPath()
  ctx.arc(0, 0, outerR, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = 'rgba(130, 144, 140, 0.45)'
  ctx.lineWidth = 1.2
  ctx.stroke()

  // Recessed dark bearing race
  ctx.fillStyle = '#475256'
  ctx.beginPath()
  ctx.arc(0, 0, outerR * 0.62, 0, Math.PI * 2)
  ctx.fill()

  // Sage-green seal ring
  ctx.strokeStyle = '#84a478'
  ctx.lineWidth = outerR * 0.11
  ctx.beginPath()
  ctx.arc(0, 0, outerR * 0.48, 0, Math.PI * 2)
  ctx.stroke()

  // Rotating inner steel hub with 2 pin holes
  ctx.rotate(angle)
  ctx.fillStyle = '#cfd7d4'
  ctx.beginPath()
  ctx.arc(0, 0, outerR * 0.34, 0, Math.PI * 2)
  ctx.fill()

  ctx.fillStyle = '#475256'
  ctx.beginPath()
  ctx.arc(outerR * 0.16, 0, outerR * 0.06, 0, Math.PI * 2)
  ctx.arc(-outerR * 0.16, 0, outerR * 0.06, 0, Math.PI * 2)
  ctx.fill()

  ctx.restore()
}

function drawCentralArticulatedMechanism(
  ctx: CanvasRenderingContext2D,
  bayX: number,
  bayW: number,
  h: number,
  s: number,
  phase: number,
) {
  // 1. Main Rotary Hub Center (Center-Left of bay, matching the reference image)
  const hubX = bayX + bayW * 0.24
  const hubY = h * 0.365
  const hubOuterR = 114 * s

  // Upper-Right Joint (J1) & Lower-Right Joint (J3)
  const j1X = bayX + bayW * 0.85
  const j1Y = h * 0.305
  const j3X = bayX + bayW * 0.83
  const j3Y = h * 0.785

  // Smooth, slow harmonic articulation of the central knuckle joint (J2)
  const strokeOsc = Math.sin(phase * 0.95)
  const j2X = bayX + bayW * (0.405 + strokeOsc * 0.042)
  const j2Y = h * (0.555 - strokeOsc * 0.032)

  // Mid-link elbow bearing between J2 and J3
  const elbowX = bayX + bayW * (0.625 + strokeOsc * 0.024)
  const elbowY = h * (0.595 + strokeOsc * 0.022)

  ctx.save()

  // ── A. Lower Articulated Link Arm (Elbow <-> J3) ──
  drawSculptedWhiteLink(ctx, elbowX, elbowY, j3X, j3Y, 44 * s, s, true)

  // ── B. Mid Horizontal Link Bridge (J2 <-> Elbow) ──
  drawSculptedWhiteLink(ctx, j2X, j2Y, elbowX, elbowY, 48 * s, s, false)

  // ── C. Telescopic Hydraulic Cylinder + Matte-White Upper Arm Shroud (J2 <-> J1) ──
  drawTelescopicActuatorArm(ctx, j2X, j2Y, j1X, j1Y, s, strokeOsc)

  // ── D. Iconic Large Matte-White C-Shroud & Rotating Concentric Hub ──
  drawLargeRotaryHub(ctx, hubX, hubY, hubOuterR, s, phase)

  // ── E. Precision Bearing Joints at J1, J2, Elbow, J3 ──
  drawBearingNode(ctx, j1X, j1Y, 38 * s, -phase * 0.9)
  drawBearingNode(ctx, j2X, j2Y, 34 * s, phase * 1.1)
  drawBearingNode(ctx, elbowX, elbowY, 32 * s, -phase * 0.8)
  drawBearingNode(ctx, j3X, j3Y, 34 * s, phase * 0.7)

  ctx.restore()
}

function drawSculptedWhiteLink(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  thickness: number,
  s: number,
  hasInnerSlot: boolean,
) {
  const dx = x2 - x1
  const dy = y2 - y1
  const len = Math.hypot(dx, dy)
  const angle = Math.atan2(dy, dx)

  ctx.save()
  ctx.translate(x1, y1)
  ctx.rotate(angle)

  // Soft drop shadow
  ctx.fillStyle = 'rgba(62, 74, 70, 0.22)'
  ctx.beginPath()
  ctx.roundRect(-thickness * 0.45 + 3 * s, -thickness * 0.5 + 6 * s, len + thickness * 0.9, thickness, thickness * 0.5)
  ctx.fill()

  // Matte-white link body
  const grad = ctx.createLinearGradient(0, -thickness * 0.5, 0, thickness * 0.5)
  grad.addColorStop(0, '#fafcfb')
  grad.addColorStop(0.55, '#eaefed')
  grad.addColorStop(1, '#cfd7d4')
  ctx.fillStyle = grad
  ctx.beginPath()
  ctx.roundRect(-thickness * 0.45, -thickness * 0.5, len + thickness * 0.9, thickness, thickness * 0.5)
  ctx.fill()

  ctx.strokeStyle = 'rgba(136, 150, 146, 0.48)'
  ctx.lineWidth = 1.1
  ctx.stroke()

  if (hasInnerSlot) {
    ctx.strokeStyle = 'rgba(136, 150, 146, 0.38)'
    ctx.fillStyle = '#dde4e2'
    ctx.beginPath()
    ctx.roundRect(len * 0.22, -thickness * 0.22, len * 0.56, thickness * 0.44, thickness * 0.18)
    ctx.fill()
    ctx.stroke()
  }

  ctx.restore()
}

function drawTelescopicActuatorArm(
  ctx: CanvasRenderingContext2D,
  j2X: number,
  j2Y: number,
  j1X: number,
  j1Y: number,
  s: number,
  strokeOsc: number,
) {
  const dx = j1X - j2X
  const dy = j1Y - j2Y
  const totalLen = Math.hypot(dx, dy)
  const angle = Math.atan2(dy, dx)
  const armH = 68 * s

  ctx.save()
  ctx.translate(j2X, j2Y)
  ctx.rotate(angle)

  // 1. Exposed Telescopic Chrome & Sage-Green Hydraulic Cylinder (Left Half of Span)
  const pistonSpan = totalLen * 0.54
  const halfH = armH * 0.42

  // Brushed dark-steel & sage-tinted central cylinder barrel
  const cylGrad = ctx.createLinearGradient(0, -halfH, 0, halfH)
  cylGrad.addColorStop(0, '#3f494d')
  cylGrad.addColorStop(0.28, '#9eb596')
  cylGrad.addColorStop(0.5, '#e8efec')
  cylGrad.addColorStop(0.75, '#596763')
  cylGrad.addColorStop(1, '#283033')
  ctx.fillStyle = cylGrad
  ctx.fillRect(24 * s, -halfH * 0.72, pistonSpan, halfH * 1.44)

  // Twin polished chrome guide rods top & bottom of the barrel
  const rodGrad = ctx.createLinearGradient(0, -halfH, 0, -halfH + 10 * s)
  rodGrad.addColorStop(0, '#ffffff')
  rodGrad.addColorStop(0.5, '#cbd5d2')
  rodGrad.addColorStop(1, '#64706d')
  ctx.fillStyle = rodGrad
  ctx.fillRect(24 * s, -halfH, pistonSpan, 9 * s)
  ctx.fillRect(24 * s, halfH - 9 * s, pistonSpan, 9 * s)

  // Sliding chrome collar ring that moves along the piston rods with strokeOsc
  const collarX = totalLen * (0.26 + strokeOsc * 0.045)
  ctx.fillStyle = '#eef2f0'
  ctx.strokeStyle = '#8b9995'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.roundRect(collarX, -halfH - 3 * s, 14 * s, halfH * 2 + 6 * s, 3 * s)
  ctx.fill()
  ctx.stroke()

  // 2. Sculpted Matte-White Upper Arm Shroud (Right Half of Span toward J1)
  const shroudStart = totalLen * 0.44
  const shroudLen = totalLen - shroudStart + 36 * s

  // Drop shadow under shroud
  ctx.fillStyle = 'rgba(58, 70, 66, 0.24)'
  ctx.beginPath()
  ctx.roundRect(shroudStart + 4 * s, -armH * 0.5 + 7 * s, shroudLen, armH, 14 * s)
  ctx.fill()

  const shroudGrad = ctx.createLinearGradient(0, -armH * 0.5, 0, armH * 0.5)
  shroudGrad.addColorStop(0, '#fbfdfc')
  shroudGrad.addColorStop(0.55, '#ebefed')
  shroudGrad.addColorStop(1, '#cdd6d3')
  ctx.fillStyle = shroudGrad
  ctx.beginPath()
  ctx.roundRect(shroudStart, -armH * 0.5, shroudLen, armH, 14 * s)
  ctx.fill()

  ctx.strokeStyle = 'rgba(132, 146, 142, 0.48)'
  ctx.lineWidth = 1.2
  ctx.stroke()

  // Countersunk bolts on the white arm shroud
  drawCountersunkScrew(ctx, shroudStart + 16 * s, -armH * 0.28, 3.4 * s)
  drawCountersunkScrew(ctx, shroudStart + 16 * s, armH * 0.28, 3.4 * s)

  // 3. Sculpted Matte-White Knuckle Clevis around J2
  ctx.fillStyle = shroudGrad
  ctx.beginPath()
  ctx.roundRect(-36 * s, -armH * 0.52, 72 * s, armH * 1.04, 22 * s)
  ctx.fill()
  ctx.stroke()

  ctx.restore()
}

function drawLargeRotaryHub(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  outerR: number,
  s: number,
  phase: number,
) {
  ctx.save()
  ctx.translate(cx, cy)

  // 1. Rotating Inner Brushed-Steel & Sage-Green Concentric Rotor
  ctx.save()
  ctx.rotate(phase * 0.42)

  // Dark recessed rotor well
  ctx.fillStyle = '#394246'
  ctx.beginPath()
  ctx.arc(0, 0, outerR * 0.62, 0, Math.PI * 2)
  ctx.fill()

  // Sage-green precision elastomeric ring
  ctx.strokeStyle = '#89a87d'
  ctx.lineWidth = outerR * 0.08
  ctx.beginPath()
  ctx.arc(0, 0, outerR * 0.52, 0, Math.PI * 2)
  ctx.stroke()

  // Brushed aluminum rotor ring
  const rotorGrad = ctx.createLinearGradient(-outerR * 0.45, -outerR * 0.45, outerR * 0.45, outerR * 0.45)
  rotorGrad.addColorStop(0, '#f1f5f3')
  rotorGrad.addColorStop(0.5, '#b8c3c0')
  rotorGrad.addColorStop(1, '#798582')
  ctx.fillStyle = rotorGrad
  ctx.beginPath()
  ctx.arc(0, 0, outerR * 0.44, 0, Math.PI * 2)
  ctx.fill()

  // Precision radial index notches on rotor
  ctx.strokeStyle = 'rgba(55, 65, 68, 0.55)'
  ctx.lineWidth = 1.4 * s
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2
    ctx.beginPath()
    ctx.moveTo(Math.cos(a) * outerR * 0.28, Math.sin(a) * outerR * 0.28)
    ctx.lineTo(Math.cos(a) * outerR * 0.41, Math.sin(a) * outerR * 0.41)
    ctx.stroke()
  }

  // Center bearing cap
  ctx.fillStyle = '#5c676b'
  ctx.beginPath()
  ctx.arc(0, 0, outerR * 0.22, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = '#e2e8e6'
  ctx.lineWidth = 2 * s
  ctx.stroke()

  ctx.restore()

  // 2. Sculpted Matte-White C-Shaped Outer Stator Housing (with sweeping lower tail arm)
  ctx.save()
  ctx.shadowColor = 'rgba(52, 64, 60, 0.26)'
  ctx.shadowBlur = 18 * s
  ctx.shadowOffsetX = 4 * s
  ctx.shadowOffsetY = 8 * s

  const shroudGrad = ctx.createLinearGradient(-outerR, -outerR, outerR, outerR * 1.6)
  shroudGrad.addColorStop(0, '#fbfdfc')
  shroudGrad.addColorStop(0.5, '#ecf0ee')
  shroudGrad.addColorStop(1, '#cfd7d4')

  ctx.fillStyle = shroudGrad
  ctx.beginPath()
  // Outer C-arc from +0.25 rad clockwise around to -0.35 rad
  ctx.arc(0, 0, outerR, -0.22, Math.PI * 1.42, true)
  // Sweeping lower tail extension (like the reference image!)
  ctx.lineTo(outerR * 1.15, outerR * 1.95)
  ctx.lineTo(outerR * 1.38, outerR * 1.78)
  ctx.lineTo(outerR * 0.22, outerR * 0.62)
  // Inner bore arc
  ctx.arc(0, 0, outerR * 0.58, Math.PI * 0.58, -0.22, false)
  ctx.closePath()
  ctx.fill()

  ctx.shadowColor = 'transparent'
  ctx.strokeStyle = 'rgba(136, 150, 146, 0.48)'
  ctx.lineWidth = 1.2
  ctx.stroke()

  // Subtle recessed arc seam line on the white C-shroud
  ctx.strokeStyle = 'rgba(148, 163, 158, 0.38)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.arc(0, 0, outerR * 0.79, Math.PI * 0.65, Math.PI * 1.88)
  ctx.stroke()

  // Countersunk mounting screws on the white C-shroud
  for (const a of [2.1, 3.05, 4.15, 5.15]) {
    drawCountersunkScrew(
      ctx,
      Math.cos(a) * outerR * 0.79,
      Math.sin(a) * outerR * 0.79,
      3.8 * s,
    )
  }

  ctx.restore()
  ctx.restore()
}

function drawCountersunkScrew(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
) {
  ctx.save()
  ctx.translate(x, y)

  // Countersunk recess ring
  ctx.fillStyle = '#b8c2bf'
  ctx.beginPath()
  ctx.arc(0, 0, r * 1.35, 0, Math.PI * 2)
  ctx.fill()

  // Brushed steel screw head
  ctx.fillStyle = '#e4eae8'
  ctx.beginPath()
  ctx.arc(0, 0, r, 0, Math.PI * 2)
  ctx.fill()

  // Dark hex/torx socket
  ctx.fillStyle = '#475256'
  ctx.beginPath()
  ctx.arc(0, 0, r * 0.48, 0, Math.PI * 2)
  ctx.fill()

  ctx.restore()
}

function drawSteppedDividerBulkhead(
  ctx: CanvasRenderingContext2D,
  splitX: number,
  wallW: number,
  w: number,
  h: number,
  s: number,
) {
  ctx.save()

  const notchTop = h * 0.22
  const notchBot = h * 0.49
  const chamfer = 14 * s
  const stepIn = 9 * s

  // 1. Recessed Sage-Green Elastomeric Accent Strip inside the Stepped Notch
  const sageGrad = ctx.createLinearGradient(splitX, notchTop, splitX + stepIn + 8 * s, notchTop)
  sageGrad.addColorStop(0, '#6e8f62')
  sageGrad.addColorStop(0.6, '#95b389')
  sageGrad.addColorStop(1, '#58754e')
  ctx.fillStyle = sageGrad
  ctx.beginPath()
  ctx.moveTo(splitX, notchTop)
  ctx.lineTo(splitX + stepIn + 6 * s, notchTop + chamfer)
  ctx.lineTo(splitX + stepIn + 6 * s, notchBot - chamfer)
  ctx.lineTo(splitX, notchBot)
  ctx.closePath()
  ctx.fill()

  // 2. Main Sculpted Matte-White Vertical Bulkhead Wall
  const wallGrad = ctx.createLinearGradient(splitX, 0, splitX + wallW, 0)
  wallGrad.addColorStop(0, '#fbfdfc')
  wallGrad.addColorStop(0.55, '#eef2f0')
  wallGrad.addColorStop(0.88, '#dce2e0')
  wallGrad.addColorStop(1, '#b9c3c0')

  ctx.fillStyle = wallGrad
  ctx.beginPath()
  ctx.moveTo(splitX, 0)
  ctx.lineTo(w, 0)
  ctx.lineTo(w, 14 * s)
  ctx.lineTo(splitX + wallW, 14 * s)
  ctx.lineTo(splitX + wallW, h - 14 * s)
  ctx.lineTo(w, h - 14 * s)
  ctx.lineTo(w, h)
  ctx.lineTo(splitX, h)
  ctx.lineTo(splitX, notchBot)
  ctx.lineTo(splitX + stepIn, notchBot - chamfer)
  ctx.lineTo(splitX + stepIn, notchTop + chamfer)
  ctx.lineTo(splitX, notchTop)
  ctx.closePath()
  ctx.fill()

  // Crisp left architectural edge line
  ctx.strokeStyle = 'rgba(160, 174, 169, 0.55)'
  ctx.lineWidth = 1.2
  ctx.stroke()

  // Inner subtle contour line along the bulkhead
  ctx.strokeStyle = 'rgba(148, 163, 158, 0.42)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(splitX + wallW * 0.42, 0)
  ctx.lineTo(splitX + wallW * 0.42, h)
  ctx.stroke()

  // Precision countersunk screws along the vertical bulkhead
  const screwX = splitX + wallW * 0.68
  const screwYs = [0.025, 0.11, 0.25, 0.52, 0.80, 0.825, 0.935]
  for (const sy of screwYs) {
    drawCountersunkScrew(ctx, screwX, h * sy, 4.4 * s)
  }

  ctx.restore()
}

function drawGlassCoverReflections(
  ctx: CanvasRenderingContext2D,
  bayX: number,
  bayW: number,
  h: number,
  s: number,
) {
  ctx.save()
  ctx.beginPath()
  ctx.rect(bayX, 0, bayW, h)
  ctx.clip()

  // Diagonal Specular Glass Reflection Band 1 (Upper-Left to Mid-Right, matching reference image!)
  const band1Grad = ctx.createLinearGradient(bayX + bayW * 0.2, 0, bayX + bayW * 0.95, h * 0.75)
  band1Grad.addColorStop(0, 'rgba(255, 255, 255, 0.36)')
  band1Grad.addColorStop(0.5, 'rgba(255, 255, 255, 0.22)')
  band1Grad.addColorStop(1, 'rgba(255, 255, 255, 0.04)')
  ctx.fillStyle = band1Grad
  ctx.beginPath()
  ctx.moveTo(bayX + bayW * 0.22, 0)
  ctx.lineTo(bayX + bayW * 0.46, 0)
  ctx.lineTo(bayX + bayW, h * 0.62)
  ctx.lineTo(bayX + bayW, h * 0.88)
  ctx.closePath()
  ctx.fill()

  // Diagonal Specular Glass Reflection Band 2 (Mid-Left to Bottom-Right)
  const band2Grad = ctx.createLinearGradient(bayX, h * 0.25, bayX + bayW * 0.75, h)
  band2Grad.addColorStop(0, 'rgba(255, 255, 255, 0.28)')
  band2Grad.addColorStop(0.6, 'rgba(255, 255, 255, 0.18)')
  band2Grad.addColorStop(1, 'rgba(255, 255, 255, 0.05)')
  ctx.fillStyle = band2Grad
  ctx.beginPath()
  ctx.moveTo(bayX, h * 0.24)
  ctx.lineTo(bayX, h * 0.46)
  ctx.lineTo(bayX + bayW * 0.56, h)
  ctx.lineTo(bayX + bayW * 0.76, h)
  ctx.closePath()
  ctx.fill()

  // Flush Glass Perimeter Bevel Line
  const glassInset = 10 * s
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.62)'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.roundRect(
    bayX + glassInset,
    glassInset,
    bayW - glassInset * 2,
    h - glassInset * 2,
    18 * s,
  )
  ctx.stroke()

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

  pointer.vx *= 0.85
  pointer.vy *= 0.85

  // Gentle, unhurried mechanical motion; slightly responsive when hovering the right half
  const speedMult = pointer.active && pointer.x > 0.5 ? 1.35 : 1.0
  if (!reducedMotion) {
    mechPhase += dt * speedMult
  }

  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const w = canvas.width / dpr
  const h = canvas.height / dpr
  const splitX = Math.round(w * 0.495)

  ctx.save()
  ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, w, h)

  // 1. Clean Alabaster Left Canvas
  drawLeftOrganicCanvas(ctx, splitX, h)

  // 2. Clean Matte-White & Silver Mechanical Right Panel (under flush glass)
  drawRightMechanicalPanel(ctx, w, h, splitX, mechPhase)

  // 3. Artistic Hand-Drawn Botanical Grass Blades (drawn last so tall tips can gracefully overlap the white seam!)
  drawArtisticGrassBlades(ctx, w, h, splitX, elapsed, dt)

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
  background: #fbfbfa;
  overflow: hidden;
  user-select: none;
}

.biomech-canvas {
  display: block;
  width: 100%;
  height: 100%;
}
</style>
