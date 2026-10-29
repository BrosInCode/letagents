export function letagentsHome(options?: {
  homedir?: () => string;
  join?: (...segments: string[]) => string;
}): string;
export function letagentsHomePath(...segments: string[]): string;
