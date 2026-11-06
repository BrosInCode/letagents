import type { LiveDemoPoint } from "./protocol";

/** The pen's width on screen (CSS px), whatever the scale of the demo. */
export const INK_WIDTH = 3;
export const INK_WIDTH_HIGHLIGHT = 5;

function isDot(points: readonly LiveDemoPoint[]): boolean {
  const first = points[0];
  return points.every((point) => point[0] === first[0] && point[1] === first[1]);
}

/**
 * Draws one stroke. `scale` turns demo space into frame pixels. The line goes
 * through the middle of each pair of points, which rounds the corners that a
 * simplified stroke has. A pale edge keeps it visible on any page colour.
 */
export function drawStroke(
  ctx: CanvasRenderingContext2D,
  points: readonly LiveDemoPoint[],
  scale: number,
  color: string,
  width = INK_WIDTH,
): void {
  if (points.length === 0) return;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (isDot(points)) {
    const [x, y] = points[0];
    ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
    ctx.beginPath();
    ctx.arc(x * scale, y * scale, width / 2 + 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x * scale, y * scale, width / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  const path = new Path2D();
  path.moveTo(points[0][0] * scale, points[0][1] * scale);
  for (let index = 1; index < points.length - 1; index++) {
    const [x, y] = points[index];
    const [nextX, nextY] = points[index + 1];
    path.quadraticCurveTo(x * scale, y * scale, ((x + nextX) / 2) * scale, ((y + nextY) / 2) * scale);
  }
  const last = points[points.length - 1];
  path.lineTo(last[0] * scale, last[1] * scale);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
  ctx.lineWidth = width + 2;
  ctx.stroke(path);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke(path);
}
