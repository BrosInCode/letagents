<template>
  <div
    ref="panelRoot"
    class="biomech-stage"
    aria-hidden="true"
  >
    <canvas ref="canvasEl" class="biomech-canvas" />
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { symbiosisBridge, syncThemeFromDom } from './symbiosisData'

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
  baseXOffset: number
  heightRatio: number
  baseWidth: number
  archDir: number
  archAmount: number
  midControlBias: number
  tipCurl: number
  twistAt: number
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
let darkMix = 0 // 0 = Ceramic Alabaster (Light), 1 = Obsidian Titanium (Dark)
let lastScrollY = 0
let scrollVelocity = 0

function mixHex(lightHex: string, darkHex: string, t: number): string {
  if (t <= 0.001) return lightHex
  if (t >= 0.999) return darkHex
  const l = parseInt(lightHex.slice(1), 16)
  const d = parseInt(darkHex.slice(1), 16)
  const lr = (l >> 16) & 255
  const lg = (l >> 8) & 255
  const lb = l & 255
  const dr = (d >> 16) & 255
  const dg = (d >> 8) & 255
  const db = d & 255
  const r = Math.round(lr + (dr - lr) * t)
  const g = Math.round(lg + (dg - lg) * t)
  const b = Math.round(lb + (db - lb) * t)
  return `rgb(${r}, ${g}, ${b})`
}

function onWindowPointerMove(e: PointerEvent) {
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

function onWindowScroll() {
  const sy = window.scrollY || 0
  const delta = sy - lastScrollY
  lastScrollY = sy
  scrollVelocity = Math.max(-45, Math.min(45, scrollVelocity + delta * 0.25))
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. LEFT SIDE: SERENE ALABASTER CANVAS & ARTISTIC HAND-DRAWN GRASS
// ─────────────────────────────────────────────────────────────────────────────
function drawLeftOrganicCanvas(
  ctx: CanvasRenderingContext2D,
  splitX: number,
  h: number,
  dm: number,
) {
  const bgGrad = ctx.createLinearGradient(0, 0, splitX, h)
  bgGrad.addColorStop(0, mixHex('#fdfdfb', '#0b100d', dm))
  bgGrad.addColorStop(0.65, mixHex('#fafaf7', '#0e1511', dm))
  bgGrad.addColorStop(1, mixHex('#f3f5f0', '#121b16', dm))
  ctx.fillStyle = bgGrad
  ctx.fillRect(0, 0, splitX, h)

  // Subtle ambient shadow cast leftward by the central vertical mechanical wall
  const wallShadow = ctx.createLinearGradient(splitX - 54, 0, splitX, 0)
  wallShadow.addColorStop(0, 'rgba(0, 0, 0, 0)')
  wallShadow.addColorStop(0.7, `rgba(40, 56, 48, ${0.05 + dm * 0.14})`)
  wallShadow.addColorStop(1, `rgba(25, 38, 32, ${0.14 + dm * 0.28})`)
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
  dm: number,
) {
  const leftClusterAnchorX = Math.max(42, splitX * 0.11)
  const seamClusterAnchorX = splitX - 8

  for (const blade of blades) {
    const anchorX = blade.cluster === 'left' ? leftClusterAnchorX : seamClusterAnchorX
    const x0 = anchorX + blade.baseXOffset
    const y0 = h + 4
    const bladeH = blade.heightRatio * h

    // Gentle poetic breeze + subtle scroll breeze
    const breeze =
      Math.sin(t * blade.swaySpeed + blade.swayPhase) * 0.045 +
      Math.cos(t * (blade.swaySpeed * 0.6) + blade.swayPhase * 1.4) * 0.02 +
      scrollVelocity * 0.0018

    let targetBend = breeze

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

    const accel = (targetBend - blade.currentBend) * 9.5
    blade.bendVelocity = (blade.bendVelocity + accel * dt) * 0.86
    blade.currentBend += blade.bendVelocity

    const totalArch = blade.archDir * blade.archAmount + blade.currentBend
    const x1 = x0 + totalArch * bladeH * blade.midControlBias
    const y1 = y0 - bladeH * 0.36
    const x2 = x0 + totalArch * bladeH * 0.68
    const y2 = y0 - bladeH * 0.78
    const x3 = x0 + totalArch * bladeH + blade.tipCurl * bladeH * 0.42
    const y3 = y0 - bladeH + Math.abs(totalArch) * bladeH * 0.18

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

      let taper = Math.pow(1 - u, 0.82) * (0.85 + 0.25 * Math.sin(u * Math.PI))
      if (blade.twistAt > 0) {
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

    const grad = ctx.createLinearGradient(x0, y0, x3, y3)
    if (blade.tone === 'deep-sage') {
      grad.addColorStop(0, mixHex('#44633b', '#36542e', dm))
      grad.addColorStop(0.55, mixHex('#648757', '#6c965d', dm))
      grad.addColorStop(1, mixHex('#8eab80', '#9ec290', dm))
    } else if (blade.tone === 'mid-olive') {
      grad.addColorStop(0, mixHex('#557549', '#45663b', dm))
      grad.addColorStop(0.5, mixHex('#789a6a', '#82a973', dm))
      grad.addColorStop(1, mixHex('#a4be96', '#b2d1a3', dm))
    } else if (blade.tone === 'soft-sage') {
      grad.addColorStop(0, mixHex('#68895c', '#547549', dm))
      grad.addColorStop(0.55, mixHex('#8bab7d', '#94b885', dm))
      grad.addColorStop(1, mixHex('#b6cca9', '#c3ddb6', dm))
    } else {
      grad.addColorStop(0, mixHex('#7c9c70', '#628357', dm))
      grad.addColorStop(0.6, mixHex('#9cb98f', '#a6c698', dm))
      grad.addColorStop(1, mixHex('#c5d7ba', '#d2e6c7', dm))
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
    ctx.strokeStyle =
      dm > 0.5 ? 'rgba(20, 34, 18, 0.52)' : 'rgba(54, 78, 45, 0.42)'
    ctx.lineWidth = 0.75
    ctx.beginPath()
    ctx.moveTo(leftPts[0][0], leftPts[0][1])
    for (let i = 1; i <= segments; i++) {
      ctx.lineTo(leftPts[i][0], leftPts[i][1])
    }
    ctx.stroke()

    ctx.strokeStyle =
      dm > 0.5 ? 'rgba(216, 236, 206, 0.42)' : 'rgba(242, 247, 238, 0.55)'
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
  dm: number,
) {
  const wallW = Math.max(36, Math.min(54, w * 0.036))
  const bayX = splitX + wallW
  const bayW = Math.max(1, w - bayX)
  const s = Math.min(bayW / 680, h / 780)

  ctx.save()

  // ── A. Recessed Machined Satin-Alabaster / Anodized Titanium Backplate ──
  const trayGrad = ctx.createLinearGradient(bayX, 0, w, h)
  trayGrad.addColorStop(0, mixHex('#d2dad7', '#131917', dm))
  trayGrad.addColorStop(0.5, mixHex('#dce3e0', '#18201d', dm))
  trayGrad.addColorStop(1, mixHex('#c9d2cf', '#101614', dm))
  ctx.fillStyle = trayGrad
  ctx.fillRect(bayX, 0, bayW, h)

  ctx.strokeStyle =
    dm > 0.5 ? 'rgba(148, 168, 158, 0.12)' : 'rgba(100, 114, 110, 0.18)'
  ctx.lineWidth = 1
  const pad = 24 * s
  ctx.strokeRect(bayX + pad, pad, bayW - pad * 2, h - pad * 2)

  // ── B. Clean Parallel Sage-Green Conduit Ribbons (Background Bus) ──
  drawSageConduitRibbons(ctx, bayX, bayW, h, s, phase, dm)

  // ── C. 1. Upper-Left Horizontal Brushed-Metal Roller / Damper Cylinder ──
  drawUpperRollerCylinder(ctx, bayX + bayW * 0.25, h * 0.125, s, phase, dm)

  // ── D. 2. Upper-Right Clean Matte-White Manifold Module ──
  drawMatteWhiteModule(
    ctx,
    bayX + bayW * 0.53,
    h * 0.035,
    bayW * 0.42,
    h * 0.175,
    s,
    true,
    dm,
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
    dm,
  )
  drawMatteWhiteModule(
    ctx,
    bayX + bayW * 0.255,
    h * 0.73,
    bayW * 0.23,
    h * 0.135,
    s,
    false,
    dm,
  )
  drawMatteWhiteModule(
    ctx,
    bayX + bayW * 0.79,
    h * 0.48,
    bayW * 0.18,
    h * 0.19,
    s,
    false,
    dm,
  )

  // ── F. 4. Lower-Left Horizontal Sage-Fluid Damper Capsule ──
  drawLowerFluidDamper(ctx, bayX + bayW * 0.15, h * 0.915, s, phase, dm)

  // ── G. 5. ICONIC CENTERPIECE: Large Rotary Hub + Articulated Dual-Link Arm & Telescopic Piston ──
  drawCentralArticulatedMechanism(ctx, bayX, bayW, h, s, phase, dm)

  // ── H. Sculpted Vertical Divider Bulkhead (with Stepped Sage Notch) ──
  drawSteppedDividerBulkhead(ctx, splitX, wallW, w, h, s, dm)

  // ── I. Flush Protective Glass Cover Plate & Diagonal Specular Reflections ──
  drawGlassCoverReflections(ctx, bayX, bayW, h, s, dm)

  ctx.restore()
}

function drawSageConduitRibbons(
  ctx: CanvasRenderingContext2D,
  bayX: number,
  bayW: number,
  h: number,
  s: number,
  phase: number,
  dm: number,
) {
  ctx.save()

  const trackOffsets = [-9, -3, 3, 9].map((o) => o * s)
  const colEven = mixHex('#749468', '#5e8252', dm)
  const colOdd = mixHex('#8fad82', '#7ca16f', dm)

  for (let i = 0; i < trackOffsets.length; i++) {
    const off = trackOffsets[i]
    const sx = bayX + bayW * 0.56 + off
    const sy = h * 0.19
    const turnY = h * 0.265 + off
    const ex = bayX + bayW * 0.82

    ctx.strokeStyle = i % 2 === 0 ? colEven : colOdd
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

  for (let i = 0; i < trackOffsets.length; i++) {
    const off = trackOffsets[i]
    const sx = bayX + bayW * 0.19 + off
    const sy = h * 0.55
    const turnY = h * 0.675 + off
    const turnX = bayX + bayW * 0.66 + off
    const ey = h * 0.88

    ctx.strokeStyle = i % 2 === 0 ? colEven : colOdd
    ctx.lineWidth = 3.2 * s
    ctx.beginPath()
    ctx.moveTo(sx, sy)
    ctx.lineTo(sx, turnY - 16 * s)
    ctx.quadraticCurveTo(sx, turnY, sx + 16 * s, turnY)
    ctx.lineTo(turnX - 16 * s, turnY)
    ctx.quadraticCurveTo(turnX, turnY, turnX, turnY + 16 * s)
    ctx.lineTo(turnX, ey)
    ctx.stroke()

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
  dm: number,
) {
  ctx.save()
  ctx.translate(cx, cy)

  const totalW = 195 * s
  const cylH = 66 * s

  ctx.fillStyle = `rgba(15, 22, 19, ${0.18 + dm * 0.25})`
  ctx.beginPath()
  ctx.roundRect(-totalW * 0.5 + 4 * s, -cylH * 0.5 + 6 * s, totalW, cylH, 10 * s)
  ctx.fill()

  const darkGrad = ctx.createLinearGradient(0, -cylH * 0.44, 0, cylH * 0.44)
  darkGrad.addColorStop(0, '#374146')
  darkGrad.addColorStop(0.32, '#79848a')
  darkGrad.addColorStop(0.52, '#495358')
  darkGrad.addColorStop(1, '#232a2e')
  ctx.fillStyle = darkGrad
  ctx.beginPath()
  ctx.roundRect(-12 * s, -cylH * 0.44, totalW * 0.5, cylH * 0.88, 6 * s)
  ctx.fill()

  const whiteGrad = ctx.createLinearGradient(0, -cylH * 0.5, 0, cylH * 0.5)
  whiteGrad.addColorStop(0, mixHex('#f8faf9', '#25302c', dm))
  whiteGrad.addColorStop(0.55, mixHex('#e6ecea', '#1d2623', dm))
  whiteGrad.addColorStop(1, mixHex('#c8d1ce', '#141b19', dm))
  ctx.fillStyle = whiteGrad
  ctx.beginPath()
  ctx.roundRect(-totalW * 0.36, -cylH * 0.5, totalW * 0.34, cylH, 7 * s)
  ctx.fill()
  ctx.strokeStyle = 'rgba(148, 163, 158, 0.35)'
  ctx.lineWidth = 1
  ctx.stroke()

  ctx.save()
  ctx.beginPath()
  ctx.rect(-12 * s, -cylH * 0.44, totalW * 0.5, cylH * 0.88)
  ctx.clip()

  const stripeSpacing = 9 * s
  const offset = (((phase * 14 * s) % stripeSpacing) + stripeSpacing) % stripeSpacing
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)'
  ctx.lineWidth = 1.5 * s
  for (let y = -cylH * 0.5 + offset; y <= cylH * 0.5; y += stripeSpacing) {
    ctx.beginPath()
    ctx.moveTo(-8 * s, y)
    ctx.lineTo(totalW * 0.36, y)
    ctx.stroke()
  }
  ctx.restore()

  ctx.fillStyle = mixHex('#aeb8b5', '#333f3b', dm)
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
  dm: number,
) {
  ctx.save()
  ctx.translate(cx, cy)

  const w = 128 * s
  const h = 48 * s

  const fluidGrad = ctx.createLinearGradient(0, -h * 0.38, 0, h * 0.38)
  fluidGrad.addColorStop(0, '#6a8a5e')
  fluidGrad.addColorStop(0.4, '#a6c49a')
  fluidGrad.addColorStop(1, '#4c6942')
  ctx.fillStyle = fluidGrad
  ctx.fillRect(-w * 0.38, -h * 0.36, w * 0.76, h * 0.72)

  const ringX = Math.sin(phase * 1.1) * (w * 0.16)
  ctx.fillStyle = mixHex('#e6ecea', '#283430', dm)
  ctx.fillRect(ringX - 4 * s, -h * 0.36, 8 * s, h * 0.72)

  const capGrad = ctx.createLinearGradient(0, -h * 0.5, 0, h * 0.5)
  capGrad.addColorStop(0, mixHex('#f4f7f6', '#2a3632', dm))
  capGrad.addColorStop(0.5, mixHex('#d0d8d5', '#1d2623', dm))
  capGrad.addColorStop(1, mixHex('#98a39f', '#131917', dm))
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
  dm: number,
) {
  ctx.save()

  ctx.fillStyle = `rgba(18, 26, 22, ${0.16 + dm * 0.28})`
  ctx.beginPath()
  ctx.roundRect(x + 4 * s, y + 6 * s, w, h, 14 * s)
  ctx.fill()

  const bodyGrad = ctx.createLinearGradient(x, y, x, y + h)
  bodyGrad.addColorStop(0, mixHex('#f9fbfa', '#242f2b', dm))
  bodyGrad.addColorStop(0.65, mixHex('#edf1ef', '#1c2522', dm))
  bodyGrad.addColorStop(1, mixHex('#dde3e0', '#151c19', dm))
  ctx.fillStyle = bodyGrad
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, 14 * s)
  ctx.fill()

  ctx.strokeStyle =
    dm > 0.5 ? 'rgba(255, 255, 255, 0.14)' : 'rgba(255, 255, 255, 0.85)'
  ctx.lineWidth = 1.4
  ctx.stroke()
  ctx.strokeStyle = 'rgba(138, 152, 147, 0.32)'
  ctx.lineWidth = 1
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)

  ctx.strokeStyle = 'rgba(148, 163, 158, 0.26)'
  ctx.beginPath()
  ctx.moveTo(x + 14 * s, y + h * 0.72)
  ctx.lineTo(x + w - 14 * s, y + h * 0.72)
  ctx.stroke()

  const inset = 13 * s
  for (const [bx, by] of [
    [x + inset, y + inset],
    [x + w - inset, y + inset],
    [x + inset, y + h - inset],
    [x + w - inset, y + h - inset],
  ] as const) {
    drawCountersunkScrew(ctx, bx, by, 3.8 * s, dm)
  }

  if (hasBottomPorts) {
    for (let i = 0; i < 3; i++) {
      const px = x + 26 * s + i * 24 * s
      const py = y + h
      ctx.fillStyle = mixHex('#dfe5e3', '#1e2724', dm)
      ctx.strokeStyle = 'rgba(148, 163, 158, 0.42)'
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
  dm: number,
) {
  ctx.save()
  ctx.translate(x, y)

  const bossGrad = ctx.createRadialGradient(-outerR * 0.25, -outerR * 0.25, 2, 0, 0, outerR)
  bossGrad.addColorStop(0, mixHex('#fafcfb', '#283430', dm))
  bossGrad.addColorStop(0.7, mixHex('#e4eae8', '#1d2623', dm))
  bossGrad.addColorStop(1, mixHex('#bcc6c3', '#121816', dm))
  ctx.fillStyle = bossGrad
  ctx.beginPath()
  ctx.arc(0, 0, outerR, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = 'rgba(130, 144, 140, 0.4)'
  ctx.lineWidth = 1.2
  ctx.stroke()

  ctx.fillStyle = mixHex('#475256', '#0e1312', dm)
  ctx.beginPath()
  ctx.arc(0, 0, outerR * 0.62, 0, Math.PI * 2)
  ctx.fill()

  ctx.strokeStyle = '#84a478'
  ctx.lineWidth = outerR * 0.11
  ctx.beginPath()
  ctx.arc(0, 0, outerR * 0.48, 0, Math.PI * 2)
  ctx.stroke()

  ctx.rotate(angle)
  ctx.fillStyle = mixHex('#cfd7d4', '#33403c', dm)
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
  dm: number,
) {
  const hubX = bayX + bayW * 0.24
  const hubY = h * 0.365
  const hubOuterR = 114 * s

  const j1X = bayX + bayW * 0.85
  const j1Y = h * 0.305
  const j3X = bayX + bayW * 0.83
  const j3Y = h * 0.785

  const strokeOsc = Math.sin(phase * 0.95)
  const j2X = bayX + bayW * (0.405 + strokeOsc * 0.042)
  const j2Y = h * (0.555 - strokeOsc * 0.032)

  const elbowX = bayX + bayW * (0.625 + strokeOsc * 0.024)
  const elbowY = h * (0.595 + strokeOsc * 0.022)

  ctx.save()

  drawSculptedWhiteLink(ctx, elbowX, elbowY, j3X, j3Y, 44 * s, s, true, dm)
  drawSculptedWhiteLink(ctx, j2X, j2Y, elbowX, elbowY, 48 * s, s, false, dm)
  drawTelescopicActuatorArm(ctx, j2X, j2Y, j1X, j1Y, s, strokeOsc, dm)
  drawLargeRotaryHub(ctx, hubX, hubY, hubOuterR, s, phase, dm)

  drawBearingNode(ctx, j1X, j1Y, 38 * s, -phase * 0.9, dm)
  drawBearingNode(ctx, j2X, j2Y, 34 * s, phase * 1.1, dm)
  drawBearingNode(ctx, elbowX, elbowY, 32 * s, -phase * 0.8, dm)
  drawBearingNode(ctx, j3X, j3Y, 34 * s, phase * 0.7, dm)

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
  dm: number,
) {
  const dx = x2 - x1
  const dy = y2 - y1
  const len = Math.hypot(dx, dy)
  const angle = Math.atan2(dy, dx)

  ctx.save()
  ctx.translate(x1, y1)
  ctx.rotate(angle)

  ctx.fillStyle = `rgba(18, 26, 22, ${0.2 + dm * 0.28})`
  ctx.beginPath()
  ctx.roundRect(
    -thickness * 0.45 + 3 * s,
    -thickness * 0.5 + 6 * s,
    len + thickness * 0.9,
    thickness,
    thickness * 0.5,
  )
  ctx.fill()

  const grad = ctx.createLinearGradient(0, -thickness * 0.5, 0, thickness * 0.5)
  grad.addColorStop(0, mixHex('#fafcfb', '#283430', dm))
  grad.addColorStop(0.55, mixHex('#eaefed', '#1e2724', dm))
  grad.addColorStop(1, mixHex('#cfd7d4', '#141b19', dm))
  ctx.fillStyle = grad
  ctx.beginPath()
  ctx.roundRect(-thickness * 0.45, -thickness * 0.5, len + thickness * 0.9, thickness, thickness * 0.5)
  ctx.fill()

  ctx.strokeStyle = 'rgba(136, 150, 146, 0.42)'
  ctx.lineWidth = 1.1
  ctx.stroke()

  if (hasInnerSlot) {
    ctx.strokeStyle = 'rgba(136, 150, 146, 0.34)'
    ctx.fillStyle = mixHex('#dde4e2', '#151c19', dm)
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
  dm: number,
) {
  const dx = j1X - j2X
  const dy = j1Y - j2Y
  const totalLen = Math.hypot(dx, dy)
  const angle = Math.atan2(dy, dx)
  const armH = 68 * s

  ctx.save()
  ctx.translate(j2X, j2Y)
  ctx.rotate(angle)

  const pistonSpan = totalLen * 0.54
  const halfH = armH * 0.42

  const cylGrad = ctx.createLinearGradient(0, -halfH, 0, halfH)
  cylGrad.addColorStop(0, '#3f494d')
  cylGrad.addColorStop(0.28, '#9eb596')
  cylGrad.addColorStop(0.5, '#e8efec')
  cylGrad.addColorStop(0.75, '#596763')
  cylGrad.addColorStop(1, '#283033')
  ctx.fillStyle = cylGrad
  ctx.fillRect(24 * s, -halfH * 0.72, pistonSpan, halfH * 1.44)

  const rodGrad = ctx.createLinearGradient(0, -halfH, 0, -halfH + 10 * s)
  rodGrad.addColorStop(0, '#ffffff')
  rodGrad.addColorStop(0.5, '#cbd5d2')
  rodGrad.addColorStop(1, '#64706d')
  ctx.fillStyle = rodGrad
  ctx.fillRect(24 * s, -halfH, pistonSpan, 9 * s)
  ctx.fillRect(24 * s, halfH - 9 * s, pistonSpan, 9 * s)

  const collarX = totalLen * (0.26 + strokeOsc * 0.045)
  ctx.fillStyle = mixHex('#eef2f0', '#25302c', dm)
  ctx.strokeStyle = '#8b9995'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.roundRect(collarX, -halfH - 3 * s, 14 * s, halfH * 2 + 6 * s, 3 * s)
  ctx.fill()
  ctx.stroke()

  const shroudStart = totalLen * 0.44
  const shroudLen = totalLen - shroudStart + 36 * s

  ctx.fillStyle = `rgba(18, 26, 22, ${0.22 + dm * 0.3})`
  ctx.beginPath()
  ctx.roundRect(shroudStart + 4 * s, -armH * 0.5 + 7 * s, shroudLen, armH, 14 * s)
  ctx.fill()

  const shroudGrad = ctx.createLinearGradient(0, -armH * 0.5, 0, armH * 0.5)
  shroudGrad.addColorStop(0, mixHex('#fbfdfc', '#2a3632', dm))
  shroudGrad.addColorStop(0.55, mixHex('#ebefed', '#1e2724', dm))
  shroudGrad.addColorStop(1, mixHex('#cdd6d3', '#151c19', dm))
  ctx.fillStyle = shroudGrad
  ctx.beginPath()
  ctx.roundRect(shroudStart, -armH * 0.5, shroudLen, armH, 14 * s)
  ctx.fill()

  ctx.strokeStyle = 'rgba(132, 146, 142, 0.42)'
  ctx.lineWidth = 1.2
  ctx.stroke()

  drawCountersunkScrew(ctx, shroudStart + 16 * s, -armH * 0.28, 3.4 * s, dm)
  drawCountersunkScrew(ctx, shroudStart + 16 * s, armH * 0.28, 3.4 * s, dm)

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
  dm: number,
) {
  ctx.save()
  ctx.translate(cx, cy)

  ctx.save()
  ctx.rotate(phase * 0.42)

  ctx.fillStyle = mixHex('#394246', '#0e1312', dm)
  ctx.beginPath()
  ctx.arc(0, 0, outerR * 0.62, 0, Math.PI * 2)
  ctx.fill()

  ctx.strokeStyle = '#89a87d'
  ctx.lineWidth = outerR * 0.08
  ctx.beginPath()
  ctx.arc(0, 0, outerR * 0.52, 0, Math.PI * 2)
  ctx.stroke()

  const rotorGrad = ctx.createLinearGradient(
    -outerR * 0.45,
    -outerR * 0.45,
    outerR * 0.45,
    outerR * 0.45,
  )
  rotorGrad.addColorStop(0, mixHex('#f1f5f3', '#35423e', dm))
  rotorGrad.addColorStop(0.5, mixHex('#b8c3c0', '#242e2b', dm))
  rotorGrad.addColorStop(1, mixHex('#798582', '#171f1c', dm))
  ctx.fillStyle = rotorGrad
  ctx.beginPath()
  ctx.arc(0, 0, outerR * 0.44, 0, Math.PI * 2)
  ctx.fill()

  ctx.strokeStyle = 'rgba(55, 65, 68, 0.55)'
  ctx.lineWidth = 1.4 * s
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2
    ctx.beginPath()
    ctx.moveTo(Math.cos(a) * outerR * 0.28, Math.sin(a) * outerR * 0.28)
    ctx.lineTo(Math.cos(a) * outerR * 0.41, Math.sin(a) * outerR * 0.41)
    ctx.stroke()
  }

  ctx.fillStyle = '#5c676b'
  ctx.beginPath()
  ctx.arc(0, 0, outerR * 0.22, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = mixHex('#e2e8e6', '#45544f', dm)
  ctx.lineWidth = 2 * s
  ctx.stroke()

  ctx.restore()

  ctx.save()
  ctx.shadowColor = `rgba(18, 26, 22, ${0.24 + dm * 0.35})`
  ctx.shadowBlur = 18 * s
  ctx.shadowOffsetX = 4 * s
  ctx.shadowOffsetY = 8 * s

  const shroudGrad = ctx.createLinearGradient(-outerR, -outerR, outerR, outerR * 1.6)
  shroudGrad.addColorStop(0, mixHex('#fbfdfc', '#2a3632', dm))
  shroudGrad.addColorStop(0.5, mixHex('#ecf0ee', '#1f2825', dm))
  shroudGrad.addColorStop(1, mixHex('#cfd7d4', '#151c19', dm))

  ctx.fillStyle = shroudGrad
  ctx.beginPath()
  ctx.arc(0, 0, outerR, -0.22, Math.PI * 1.42, true)
  ctx.lineTo(outerR * 1.15, outerR * 1.95)
  ctx.lineTo(outerR * 1.38, outerR * 1.78)
  ctx.lineTo(outerR * 0.22, outerR * 0.62)
  ctx.arc(0, 0, outerR * 0.58, Math.PI * 0.58, -0.22, false)
  ctx.closePath()
  ctx.fill()

  ctx.shadowColor = 'transparent'
  ctx.strokeStyle = 'rgba(136, 150, 146, 0.44)'
  ctx.lineWidth = 1.2
  ctx.stroke()

  ctx.strokeStyle = 'rgba(148, 163, 158, 0.34)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.arc(0, 0, outerR * 0.79, Math.PI * 0.65, Math.PI * 1.88)
  ctx.stroke()

  for (const a of [2.1, 3.05, 4.15, 5.15]) {
    drawCountersunkScrew(
      ctx,
      Math.cos(a) * outerR * 0.79,
      Math.sin(a) * outerR * 0.79,
      3.8 * s,
      dm,
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
  dm: number,
) {
  ctx.save()
  ctx.translate(x, y)

  ctx.fillStyle = mixHex('#b8c2bf', '#101513', dm)
  ctx.beginPath()
  ctx.arc(0, 0, r * 1.35, 0, Math.PI * 2)
  ctx.fill()

  ctx.fillStyle = mixHex('#e4eae8', '#33403c', dm)
  ctx.beginPath()
  ctx.arc(0, 0, r, 0, Math.PI * 2)
  ctx.fill()

  ctx.fillStyle = mixHex('#475256', '#0a0e0d', dm)
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
  dm: number,
) {
  ctx.save()

  const notchTop = h * 0.22
  const notchBot = h * 0.49
  const chamfer = 14 * s
  const stepIn = 9 * s

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

  const wallGrad = ctx.createLinearGradient(splitX, 0, splitX + wallW, 0)
  wallGrad.addColorStop(0, mixHex('#fbfdfc', '#25302c', dm))
  wallGrad.addColorStop(0.55, mixHex('#eef2f0', '#1d2623', dm))
  wallGrad.addColorStop(0.88, mixHex('#dce2e0', '#161d1b', dm))
  wallGrad.addColorStop(1, mixHex('#b9c3c0', '#101513', dm))

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

  ctx.strokeStyle = 'rgba(160, 174, 169, 0.45)'
  ctx.lineWidth = 1.2
  ctx.stroke()

  ctx.strokeStyle = 'rgba(148, 163, 158, 0.32)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(splitX + wallW * 0.42, 0)
  ctx.lineTo(splitX + wallW * 0.42, h)
  ctx.stroke()

  const screwX = splitX + wallW * 0.68
  const screwYs = [0.025, 0.11, 0.25, 0.52, 0.8, 0.825, 0.935]
  for (const sy of screwYs) {
    drawCountersunkScrew(ctx, screwX, h * sy, 4.4 * s, dm)
  }

  ctx.restore()
}

function drawGlassCoverReflections(
  ctx: CanvasRenderingContext2D,
  bayX: number,
  bayW: number,
  h: number,
  s: number,
  dm: number,
) {
  ctx.save()
  ctx.beginPath()
  ctx.rect(bayX, 0, bayW, h)
  ctx.clip()

  const reflAlpha = 1 - dm * 0.62

  const band1Grad = ctx.createLinearGradient(bayX + bayW * 0.2, 0, bayX + bayW * 0.95, h * 0.75)
  band1Grad.addColorStop(0, `rgba(255, 255, 255, ${0.36 * reflAlpha})`)
  band1Grad.addColorStop(0.5, `rgba(255, 255, 255, ${0.22 * reflAlpha})`)
  band1Grad.addColorStop(1, `rgba(255, 255, 255, ${0.04 * reflAlpha})`)
  ctx.fillStyle = band1Grad
  ctx.beginPath()
  ctx.moveTo(bayX + bayW * 0.22, 0)
  ctx.lineTo(bayX + bayW * 0.46, 0)
  ctx.lineTo(bayX + bayW, h * 0.62)
  ctx.lineTo(bayX + bayW, h * 0.88)
  ctx.closePath()
  ctx.fill()

  const band2Grad = ctx.createLinearGradient(bayX, h * 0.25, bayX + bayW * 0.75, h)
  band2Grad.addColorStop(0, `rgba(255, 255, 255, ${0.28 * reflAlpha})`)
  band2Grad.addColorStop(0.6, `rgba(255, 255, 255, ${0.18 * reflAlpha})`)
  band2Grad.addColorStop(1, `rgba(255, 255, 255, ${0.05 * reflAlpha})`)
  ctx.fillStyle = band2Grad
  ctx.beginPath()
  ctx.moveTo(bayX, h * 0.24)
  ctx.lineTo(bayX, h * 0.46)
  ctx.lineTo(bayX + bayW * 0.56, h)
  ctx.lineTo(bayX + bayW * 0.76, h)
  ctx.closePath()
  ctx.fill()

  const glassInset = 10 * s
  ctx.strokeStyle = `rgba(255, 255, 255, ${0.62 * reflAlpha})`
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
  scrollVelocity *= 0.88

  // Smoothly interpolate dark mode mix [0..1]
  const targetDark = symbiosisBridge.theme === 'dark' ? 1 : 0
  darkMix += (targetDark - darkMix) * 0.09

  const speedMult =
    (pointer.active && pointer.x > 0.5 ? 1.35 : 1.0) + Math.abs(scrollVelocity) * 0.06
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

  drawLeftOrganicCanvas(ctx, splitX, h, darkMix)
  drawRightMechanicalPanel(ctx, w, h, splitX, mechPhase, darkMix)
  drawArtisticGrassBlades(ctx, w, h, splitX, elapsed, dt, darkMix)

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
  syncThemeFromDom()
  darkMix = symbiosisBridge.theme === 'dark' ? 1 : 0
  reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  syncCanvasSize()

  window.addEventListener('pointermove', onWindowPointerMove, { passive: true })
  window.addEventListener('scroll', onWindowScroll, { passive: true })

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
  if (typeof window !== 'undefined') {
    window.removeEventListener('pointermove', onWindowPointerMove)
    window.removeEventListener('scroll', onWindowScroll)
    if (rafId) window.cancelAnimationFrame(rafId)
  }
  resizeObserver?.disconnect()
})
</script>

<style scoped>
.biomech-stage {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  z-index: 0;
  pointer-events: none;
  overflow: hidden;
  user-select: none;
}

.biomech-canvas {
  display: block;
  width: 100%;
  height: 100%;
}
</style>
