import type { DesktopPageConfirmKind, DesktopPageThemeMode, DesktopRoomPage } from "../../../../../../electron/ipc-types";
import { roomPageIdOfTab, roomPageTabId, type RoomTab, type RoomTabId } from "../room-shell/types";

/** Pinned pages that get their own tab; more than this go into one "Pages" menu. */
export const MAX_ROOM_PAGE_TABS = 3;

/**
 * The room's tabs with its pinned pages after them. A room with no pages gets
 * its tab list back unchanged; with more than three, the page tabs go into
 * the Pages menu instead.
 */
export function withRoomPageTabs(tabs: RoomTab[], pages: readonly DesktopRoomPage[]): { tabs: RoomTab[]; pagesMenu: RoomTab[] } {
  if (pages.length === 0) return { tabs, pagesMenu: [] };
  const pageTabs = pages.map((page): RoomTab => ({ id: roomPageTabId(page.id), label: page.title, count: null }));
  return pages.length <= MAX_ROOM_PAGE_TABS
    ? { tabs: [...tabs, ...pageTabs], pagesMenu: [] }
    : { tabs, pagesMenu: pageTabs };
}

/**
 * A page tab that was remembered or asked for but is no longer pinned falls
 * back to chat, once the room's pages are known. Other tabs are left alone.
 */
export function availableRoomTab(tab: RoomTabId, pages: readonly DesktopRoomPage[], pagesLoaded: boolean): RoomTabId {
  const pageId = roomPageIdOfTab(tab);
  if (pageId === null || !pagesLoaded) return tab;
  return pages.some((page) => page.id === pageId) ? tab : "chat";
}

/** The pages whose webviews stay alive while the room is open: those opened at least once and still pinned. */
export function keptRoomPages(pages: readonly DesktopRoomPage[], openedIds: ReadonlySet<string>): DesktopRoomPage[] {
  return pages.filter((page) => openedIds.has(page.id));
}

/** The light or dark mode the app draws an element in, which its pages follow. */
export function pageThemeModeOf(colorScheme: string, prefersDark: boolean): DesktopPageThemeMode {
  const schemes = colorScheme.split(/\s+/).filter(Boolean);
  if (schemes.includes("light") && !schemes.includes("dark")) return "light";
  if (schemes.includes("dark") && !schemes.includes("light")) return "dark";
  return prefersDark ? "dark" : "light";
}

const CONFIRM_TITLES: Record<DesktopPageConfirmKind, string> = {
  open: "Open this link?",
  job: "Ask an agent?",
  post: "Post to the room?",
};

const CONFIRM_ACTIONS: Record<DesktopPageConfirmKind, string> = {
  open: "Open link",
  job: "Ask agent",
  post: "Post",
};

/** The words of a confirm sheet; the page's own text is shown as given, never as its title. */
export function pageConfirmCopy(kind: DesktopPageConfirmKind): { title: string; action: string; targetLabel: string } {
  return {
    title: CONFIRM_TITLES[kind],
    action: CONFIRM_ACTIONS[kind],
    targetLabel: kind === "open" ? "Site" : "To",
  };
}
