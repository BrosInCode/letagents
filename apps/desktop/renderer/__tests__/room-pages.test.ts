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
  PAGE_CONFIRM_ARM_MS,
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
    assert.match(shell, /<RoomPageView\s+v-for="page in keptPages"/);
    assert.doesNotMatch(shell, /<RoomPageView[^>]*v-show/, "never display: none: Electron does not repaint such a webview");
    const pageView = readFileSync(fileURLToPath(new URL("../src/components/desktop/content/room-pages/RoomPageView.vue", import.meta.url)), "utf8");
    assert.match(pageView, /\.room-page-view\.is-hidden \{\s*visibility: hidden;\s*pointer-events: none;\s*\}/);
    assert.match(pageView, /:class="\{ 'is-hidden': !active \}"/);
    assert.match(
      pageView,
      /\.room-page-view \{[^}]*\bcontain: strict;[^}]*\}/,
      "the page never sizes the cell it shares with the chat: its webview made each chat layout take seconds",
    );
    assert.equal(shell.match(/<PageConfirmSheet \/>/g)?.length, 1);
    assert.match(shell, /:pages-menu="pagesMenu"/);
    assert.match(shell, /:active="activeTab === roomPageTabId\(page\.id\)"/, "main hears which page is in the active tab");
  });

  it("arm the confirm action only after the sheet has shown for a moment", () => {
    assert.equal(PAGE_CONFIRM_ARM_MS, 500);
    const sheet = readFileSync(fileURLToPath(new URL("../src/components/desktop/content/room-pages/PageConfirmSheet.vue", import.meta.url)), "utf8");
    assert.match(sheet, /class="primary-button" type="button" :disabled="!armed"/);
    assert.match(sheet, /if \(!current \|\| \(value === "confirmed" && !armed\.value\)\) return;/);
    const view = readFileSync(fileURLToPath(new URL("../src/components/desktop/content/room-pages/RoomPageView.vue", import.meta.url)), "utf8");
    assert.match(view, /props\.active && document\.visibilityState === "visible"/);
  });
});

describe("room page administration", async () => {
  const { pageGrantRows, pendingPageVersion, previousLiveVersion, pageUpdateChanges, rolledBackFrom } = await import("../src/components/desktop/content/room-pages/room-page-admin");
  const { revealHiddenCharacters } = await import("../src/components/desktop/content/room-pages/room-pages");
  const version = (number: number, status: string, capabilities: string[] = [], byteSize = 1000) => ({
    version: number, status, sha256: "x", byteSize, capabilities, surfaces: ["room.tab"], source: null,
    author: { kind: "agent", id: "agent:codex-1", ownerAccountId: "acct_1" }, createdAt: "2026-11-18T10:00:00Z",
  });
  const detail = (currentVersion: number | null, versions: ReturnType<typeof version>[]) => ({
    id: "page_1", title: "Sprint", slug: "sprint", owner: { kind: "room", id: "r" }, currentVersion, updatedBy: null,
    placements: [], grant: null, manifest: null, versions, createdAt: "", updatedAt: "",
  }) as never;

  it("names each capability in the registry's plain words, and marks what a page cannot hold", () => {
    assert.deepEqual(pageGrantRows(["tasks.read", "jobs.start", "rooms.admin", "made.up"]).map(({ label, grantable, note }) => ({ label, grantable, note })), [
      { label: "See the board tasks in this room", grantable: true, note: null },
      { label: "Ask an agent in this room to do work for you", grantable: true, note: "Asks the person each time" },
      { label: "Manage this room's API settings", grantable: false, note: null },
      { label: "made.up", grantable: false, note: "Unknown to this version of the app" },
    ]);
  });

  it("finds the version waiting for approval and the version an Undo goes back to", () => {
    const pages = detail(3, [version(4, "pending_approval", ["jobs.start"]), version(3, "live"), version(2, "superseded"), version(1, "superseded")]);
    assert.equal(pendingPageVersion(pages)?.version, 4);
    assert.equal(previousLiveVersion(pages)?.version, 2);
    assert.equal(pendingPageVersion(detail(3, [version(3, "live"), version(2, "pending_approval")])), null, "an older waiting version is not news");
    assert.equal(previousLiveVersion(detail(1, [version(1, "live")])), null, "a first version has nothing to undo");
    assert.equal(rolledBackFrom(pages), null);
  });

  it("after a roll back offers Redo to the next newer version, never an Undo further back", () => {
    const rolledBack = detail(2, [version(4, "superseded"), version(3, "superseded"), version(2, "live"), version(1, "superseded")]);
    assert.equal(rolledBackFrom(rolledBack)?.version, 3);
    assert.equal(previousLiveVersion(rolledBack), null);
  });

  it("shows hidden and reordering characters in a confirm sheet as visible tags", () => {
    assert.equal(revealHiddenCharacters("Move DS-7 to \u202Eesaeler\u202C now\u200B"), "Move DS-7 to ⟨U+202E⟩esaeler⟨U+202C⟩ now⟨U+200B⟩");
    assert.equal(revealHiddenCharacters("\uFEFFa\u2066b\u2069"), "⟨U+FEFF⟩a⟨U+2066⟩b⟨U+2069⟩");
    assert.equal(revealHiddenCharacters("plain text"), "plain text");
    const sheet = readFileSync(fileURLToPath(new URL("../src/components/desktop/content/room-pages/PageConfirmSheet.vue", import.meta.url)), "utf8");
    assert.match(sheet, /\{\{ shown\(request\.text\) \}\}/);
    assert.match(sheet, /\{\{ shown\(request\.target\) \}\}/);
    assert.match(sheet, /\{\{ shown\(request\.details\) \}\}/);
    assert.equal(sheet.match(/unicode-bidi: isolate;/g)?.length, 2);
  });

  it("says what an update changed", () => {
    const lines = pageUpdateChanges(detail(2, [version(2, "live", ["tasks.read", "jobs.start"], 1500), version(1, "superseded", ["tasks.read"], 1000)]));
    assert.match(lines[0], /^Version 2 replaced version 1 on /);
    assert.deepEqual(lines.slice(1), ["Now asks to: Ask an agent in this room to do work for you", "The file is 500 bytes larger."]);
  });

  it("are wired: pin from an inline demo, one grant sheet in the shell, the banner in the page view", () => {
    const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
    const demo = read("../src/components/desktop/content/desktop-chat-message/DesktopInlineHtmlDemo.vue");
    assert.match(demo, /inject\(roomPageActionsKey, null\)/);
    assert.match(demo, /v-if="canPinAsPage"[\s\S]*?aria-label="Pin to room as a page"/);
    const shell = read("../src/components/desktop/content/DesktopRoomShell.vue");
    assert.equal(shell.match(/<PageGrantSheet /g)?.length, 1);
    assert.match(shell, /props\.room\.role === "admin" && props\.storage\.effectiveMode !== "local"/);
    assert.match(shell, /provide\(roomPageActionsKey, pagePinFlow\.actions\)/);
    const view = read("../src/components/desktop/content/room-pages/RoomPageView.vue");
    assert.match(view, /Updated by \{\{ banner\.label \}\}/);
    assert.match(view, /v-if="canManage && banner\.undoVersion"/, "Undo is for room admins");
  });
});
