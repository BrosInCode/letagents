export type ContextMenuCloseReason = "action" | "complete" | "copy" | "escape" | "outside";

export interface ContextMenuFocusTarget {
  readonly isConnected: boolean;
  focus(options?: FocusOptions): void;
}

export function shouldRestoreContextMenuFocus(reason: ContextMenuCloseReason): boolean {
  return reason === "copy" || reason === "escape" || reason === "complete";
}

export function restoreContextMenuFocus(target: ContextMenuFocusTarget | null): void {
  if (target?.isConnected) target.focus({ preventScroll: true });
}
