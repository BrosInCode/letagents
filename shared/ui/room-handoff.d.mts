export const handoffStillTime: number;
export function createHandoffPainter(context: CanvasRenderingContext2D):
  (width: number, height: number, seconds: number, moving: boolean) => void;
