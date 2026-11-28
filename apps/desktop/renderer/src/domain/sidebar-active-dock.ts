/**
 * Where the open room's row sits in the scrolled room list. The sidebar uses
 * it for the "you are here" dock: while too little of the row shows, a copy
 * of it waits at the list edge the row left by.
 */

/** How much of the open room's row must show before the dock steps away. */
export const SIDEBAR_ACTIVE_ROW_VISIBLE_SHARE = 0.6;

export type SidebarDockEdge = "top" | "bottom";

type VerticalBox = { top: number; bottom: number };

/** The list edge the open room's row has left by, or null while enough of the row shows. */
export function sidebarActiveRowEdge(row: VerticalBox, list: VerticalBox): SidebarDockEdge | null {
  const height = row.bottom - row.top;
  if (height <= 0) return null;
  const shown = Math.min(row.bottom, list.bottom) - Math.max(row.top, list.top);
  if (shown >= height * SIDEBAR_ACTIVE_ROW_VISIBLE_SHARE) return null;
  return row.top < list.top ? "top" : "bottom";
}

/** True when the whole row is inside the list, so revealing it must not move the list. */
export function sidebarRowFullyVisible(row: VerticalBox, list: VerticalBox): boolean {
  return row.top >= list.top && row.bottom <= list.bottom;
}
