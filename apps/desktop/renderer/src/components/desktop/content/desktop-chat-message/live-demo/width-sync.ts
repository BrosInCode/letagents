/**
 * Tells main the frame's width, one call at a time, always ending with the
 * newest width. A window that is being resized produces many widths; only the
 * latest one matters, and main should not be asked twice at once.
 */
export interface WidthSync {
  /** `force` asks again even when this width was already applied (the page was reloaded). */
  request(width: number, force?: boolean): void;
  /** Ignores any answer still on its way. */
  close(): void;
}

export function createWidthSync(
  apply: (width: number) => Promise<number>,
  onScale: (scale: number, width: number) => void,
  onError: (error: unknown) => void,
): WidthSync {
  let wanted: number | null = null;
  let applied: number | null = null;
  let busy = false;
  let closed = false;

  async function run(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      while (!closed && wanted !== null && wanted !== applied) {
        const width = wanted;
        try {
          const scale = await apply(width);
          if (closed) return;
          applied = width;
          onScale(scale, width);
        } catch (error) {
          if (!closed) onError(error);
          return;
        }
      }
    } finally {
      busy = false;
    }
  }

  return {
    request(width, force = false) {
      if (closed) return;
      wanted = width;
      if (force) applied = null;
      void run();
    },
    close() {
      closed = true;
    },
  };
}
