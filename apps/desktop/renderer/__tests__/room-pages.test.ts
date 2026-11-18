import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  isRoomTabId,
  roomPageIdOfTab,
  roomPageTabId,
  type RoomTab,
} from "../src/components/desktop/content/room-shell/types";
import {
  availableRoomTab,
  keptRoomPages,
  MAX_ROOM_PAGE_TABS,
  pageConfirmCopy,
  pageThemeModeOf,
  withRoomPageTabs,
} from "../src/components/desktop/content/room-pages/room-pages";

const baseTabs: RoomTab[] = [
  { id: "chat", label: "Chat", count: null },
  { id: "memory", label: "Memory", count: null },
  { id: "board", label: "Board", count: null },
  { id: "activity", label: "Agents", count: null },
  { id: "rooms", label: "Rooms", count: 2 },
];
const page = (id: string, title = id, version = 1) => ({ id, title, version });

describe("room page tab ids", () => {
  it("round-trip through the stored active tab", () => {
    const id = roomPageTabId("sprint-view");
    assert.equal(id, "page:sprint-view");
    assert.equal(isRoomTabId(id), true, "a remembered page tab is restored");
    assert.equal(roomPageIdOfTab(id), "sprint-view");
    assert.equal(roomPageIdOfTab(roomPageTabId("a:b")), "a:b", "only the first prefix is the tab kind");
    for (const tab of ["chat", "memory", "events", "board", "activity", "rooms"]) {
      assert.equal(isRoomTabId(tab), true, tab);
      assert.equal(roomPageIdOfTab(tab), null, tab);
    }
    for (const value of ["page:", "pages", "Page:x", "", null, `page:${"x".repeat(300)}`]) {
      assert.equal(isRoomTabId(value), false, String(value));
    }
  });
});

describe("room page tabs", () => {
  it("leave a room with no pages exactly as it was", () => {
    const result = withRoomPageTabs(baseTabs, []);
    assert.equal(result.tabs, baseTabs, "the same list, not a copy");
    assert.deepEqual(result.pagesMenu, []);
  });

  it("add up to three pages as tabs after the room's own", () => {
    const pages = [page("a", "Sprint"), page("b", "Release"), page("c", "Triage")];
    assert.equal(MAX_ROOM_PAGE_TABS, 3);
    const result = withRoomPageTabs(baseTabs, pages);
    assert.deepEqual(result.tabs.slice(0, baseTabs.length), baseTabs);
    assert.deepEqual(result.tabs.slice(baseTabs.length), [
      { id: "page:a", label: "Sprint", count: null },
      { id: "page:b", label: "Release", count: null },
      { id: "page:c", label: "Triage", count: null },
    ]);
    assert.deepEqual(result.pagesMenu, []);
  });

  it("put more than three pages into one Pages menu", () => {
    const pages = ["a", "b", "c", "d"].map((id) => page(id));
    const result = withRoomPageTabs(baseTabs, pages);
    assert.equal(result.tabs, baseTabs);
    assert.deepEqual(result.pagesMenu.map((tab) => tab.id), ["page:a", "page:b", "page:c", "page:d"]);
  });

  it("fall back to chat for a page that is no longer pinned, once the pages are known", () => {
    const pages = [page("a")];
    assert.equal(availableRoomTab("page:gone", pages, false), "page:gone", "kept while the list loads");
    assert.equal(availableRoomTab("page:gone", pages, true), "chat");
    assert.equal(availableRoomTab("page:a", pages, true), "page:a");
    assert.equal(availableRoomTab("board", [], true), "board");
  });

  it("keep alive only pages opened once and still pinned", () => {
    const pages = [page("a"), page("b"), page("c")];
    assert.deepEqual(keptRoomPages(pages, new Set(["c", "a", "removed"])).map((entry) => entry.id), ["a", "c"]);
    assert.deepEqual(keptRoomPages(pages, new Set()), []);
  });
});

describe("room page presentation", () => {
  it("follows the app's light or dark mode", () => {
    assert.equal(pageThemeModeOf("dark", false), "dark");
    assert.equal(pageThemeModeOf("light", true), "light");
    assert.equal(pageThemeModeOf("light dark", true), "dark");
    assert.equal(pageThemeModeOf("normal", false), "light");
  });

  it("titles a confirm sheet by what it does, never by the page's text", () => {
    assert.deepEqual(pageConfirmCopy("open"), { title: "Open this link?", action: "Open link", targetLabel: "Site" });
    assert.equal(pageConfirmCopy("post").title, "Post to the room?");
    assert.equal(pageConfirmCopy("job").action, "Ask agent");
  });

  it("are hosted by the room shell with keep-alive and one confirm sheet", () => {
    const shell = readFileSync(fileURLToPath(new URL("../src/components/desktop/content/DesktopRoomShell.vue", import.meta.url)), "utf8");
    assert.match(shell, /<RoomPageView\s+v-for="page in keptPages"\s+v-show="activeTab === roomPageTabId\(page\.id\)"/);
    assert.equal(shell.match(/<PageConfirmSheet \/>/g)?.length, 1);
    assert.match(shell, /:pages-menu="pagesMenu"/);
  });
});
