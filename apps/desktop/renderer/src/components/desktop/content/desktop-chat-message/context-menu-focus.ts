export type ContextMenuCloseReason = "action" | "copy" | "escape" | "outside";

export interface ContextMenuFocusTarget {
  readonly isConnected: boolean;
  focus(options?: FocusOptions): void;
}

export function shouldRestoreContextMenuFocus(reason: ContextMenuCloseReason): boolean {
  return reason === "copy" || reason === "escape";
}

export function restoreContextMenuFocus(target: ContextMenuFocusTarget | null): void {
  if (target?.isConnected) target.focus({ preventScroll: true });
}
