import type { PageDetail } from "../../../../shared/api/pages.mjs";

/** A page pinned in a room's tab bar, in the order the room shows its pages. */
export interface DesktopRoomPage {
  id: string;
  title: string;
  version: number;
}

/** What a `<webview>` needs to show one page: main admits exactly this URL, once. */
export interface DesktopRoomPageLease {
  url: string;
  partition: string;
  page: DesktopRoomPage;
}

/** Main stopped a page: its process hung, crashed, or flooded the app with events. */
export type DesktopRoomPageEvent = {
  type: "stopped";
  url: string;
  reason: "unresponsive" | "crashed" | "overloaded";
};

export type DesktopPageThemeMode = "light" | "dark";

/** What a confirm sheet asks the person to allow on a page's behalf. */
export type DesktopPageConfirmKind = "open" | "job" | "post" | "intent";

/**
 * A confirm sheet the app draws for a page, never the page itself. `text` and
 * `target` are shown exactly as given.
 */
export interface DesktopPageConfirmRequest {
  id: string;
  kind: DesktopPageConfirmKind;
  pageTitle: string;
  pageVersion: number;
  text: string;
  target: string;
  /** Offer "Don't ask again for this page version". */
  rememberable: boolean;
}

export type DesktopPageConfirmAnswer = "confirmed" | "declined";

/** Main asks the app window to show a confirm sheet, or takes one back whose page closed. */
export type DesktopPageConfirmMessage =
  | { type: "ask"; request: DesktopPageConfirmRequest }
  | { type: "dismiss"; id: string };

/** One page as the registry knows it: versions, grant, placements and who made the live version. */
export type DesktopRoomPageDetail = PageDetail;

export interface DesktopRoomPageInfo {
  detail: DesktopRoomPageDetail;
  /** Who made the live version, for the "Updated by" line; null when nobody is recorded. */
  updatedByLabel: string | null;
}
