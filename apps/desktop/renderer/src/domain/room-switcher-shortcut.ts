export interface RoomSwitcherShortcutEvent {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
}

export interface CanOpenRoomSwitcherOptions {
  event: RoomSwitcherShortcutEvent;
  platform?: string;
  hasOpenModal: boolean | (() => boolean);
  isSwitcherOpen: boolean;
}

export function isMacPlatform(platform?: string): boolean {
  const resolved = platform ?? (typeof navigator !== 'undefined' ? navigator.platform : '');
  return /Mac|iPhone|iPad/i.test(resolved);
}

export function getRoomSwitcherShortcutLabel(platform?: string): string {
  return isMacPlatform(platform) ? '⌘ K' : 'Ctrl K';
}

/**
 * Valid ARIA keyshortcuts attribute value (W3C ARIA 1.2: space-delimited list of key chords).
 * Modifiers: Meta, Control, Alt, Shift.
 */
export function getRoomSwitcherAriaKeyShortcuts(platform?: string): string {
  return isMacPlatform(platform) ? 'Meta+K' : 'Control+K';
}

/**
 * Pure, cheap predicate testing key and modifier combinations without touching DOM.
 *
 * Rules:
 * - defaultPrevented, repeat, or IME composition -> false
 * - altKey or shiftKey -> false
 * - key must be 'k' (case-insensitive)
 * - macOS requires Cmd+K and forbids Ctrl+K (preserving native Cocoa text kill-to-end-of-line)
 * - Non-macOS requires Ctrl+K and forbids Cmd+K
 */
export function isRoomSwitcherShortcut(
  event: RoomSwitcherShortcutEvent,
  platform?: string,
): boolean {
  if (event.defaultPrevented) return false;
  if (event.repeat) return false;
  if (event.isComposing) return false;
  if (event.altKey || event.shiftKey) return false;
  if (!event.key || event.key.toLowerCase() !== 'k') return false;

  const isMac = isMacPlatform(platform);
  if (isMac) {
    if (!event.metaKey || event.ctrlKey) return false;
  } else {
    if (!event.ctrlKey || event.metaKey) return false;
  }

  return true;
}

/**
 * Pure predicate governing whether Cmd/Ctrl+K should open or maintain the room switcher.
 *
 * Evaluates cheap key/modifier checks first, and only invokes hasOpenModal if the key
 * matches and the switcher is not already open.
 */
export function canOpenRoomSwitcher(options: CanOpenRoomSwitcherOptions): boolean {
  const { event, platform, hasOpenModal, isSwitcherOpen } = options;

  if (!isRoomSwitcherShortcut(event, platform)) return false;

  // A different modal dialog is already open; never open a second modal over it.
  // Evaluated lazily only after cheap key/modifier checks pass.
  if (!isSwitcherOpen) {
    const modalOpen = typeof hasOpenModal === 'function' ? hasOpenModal() : hasOpenModal;
    if (modalOpen) return false;
  }

  return true;
}
