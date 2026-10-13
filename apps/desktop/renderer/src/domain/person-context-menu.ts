import type { DesktopContextMenuItem } from "../components/desktop/controls/DesktopContextMenu.vue";
import type { PersonTarget } from "./person-target";

/** Where a person menu opens, in viewport pixels. */
export interface PersonMenuPosition {
  x: number;
  y: number;
}

/** "menu" shows the choices. "work" opens the Work panel at once. */
export type PersonMenuAction = "menu" | "work";

/** Items for the menu opened by clicking a human participant. */
export function buildPersonContextMenuItems(input: {
  target: PersonTarget;
  viewerLogin: string | null;
}): DesktopContextMenuItem[][] {
  const viewer = input.viewerLogin?.trim().toLowerCase() || null;
  const isViewer = viewer !== null && input.target.login.trim().toLowerCase() === viewer;
  return [[
    { id: "message", label: `Message ${input.target.displayName}`, disabled: isViewer },
    { id: "work", label: "Work in this room" },
  ]];
}

/** Position for a menu. A keyboard click has no pointer position, so the element's corner is used. */
export function personMenuPosition(event: MouseEvent): PersonMenuPosition {
  if (event.detail > 0) return { x: event.clientX, y: event.clientY };
  const rect = (event.currentTarget as HTMLElement | null)?.getBoundingClientRect?.();
  return rect ? { x: rect.left, y: rect.bottom } : { x: 16, y: 16 };
}
