export const handoffStillTime: number;
export interface HandoffMark {
  progress: number;
  x: number;
  y: number;
  scale: number;
  points: ReadonlyArray<{ x: number; y: number; accent: boolean }>;
}
export function createHandoffPainter(context: CanvasRenderingContext2D):
  (width: number, height: number, seconds: number, moving: boolean, mark?: HandoffMark) => void;
