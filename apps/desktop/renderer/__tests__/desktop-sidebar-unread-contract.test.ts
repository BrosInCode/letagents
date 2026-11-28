import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const sidebarSource = readFileSync(
  fileURLToPath(new URL("../src/components/desktop/sidebar/DesktopSidebar.vue", import.meta.url)),
  "utf8",
);

describe("desktop sidebar unread badge contract", () => {
  it("both parent rows total the group through the same collapsed-aware helper", () => {
    assert.equal(sidebarSource.match(/<RoomUnreadBadge v-bind="projectUnreadBadge\(project\)" \/>/g)?.length, 2);
    assert.doesNotMatch(sidebarSource, /RoomUnreadBadge :count="project\.parent\.unreadCount/);
    assert.match(
      sidebarSource,
      /function projectUnreadBadge\(project: ProjectGroup\)[\s\S]*?sidebarGroupUnread\(project, projectIsCollapsed\(project\.id\), roomNotificationsMuted\)/,
    );
  });

  it("rooms behind the overflow button keep their unread count on that button", () => {
    assert.equal(sidebarSource.match(/<RoomUnreadBadge v-bind="projectOverflowUnreadBadge\(project\)" \/>/g)?.length, 2);
    assert.match(
      sidebarSource,
      /function projectOverflowUnreadBadge\(project: ProjectGroup\)[\s\S]*?visibleProjectChildRooms\(project\)[\s\S]*?projectChildRooms\(project\)\.filter[\s\S]*?sidebarUnreadTotal\(hidden, \{ isMuted: roomNotificationsMuted \}\)/,
    );
  });

  it("single rooms keep their own count and mention mark in child rows and search results", () => {
    const switcher = readFileSync(new URL("../src/components/desktop/sidebar/SidebarRoomSwitcher.vue", import.meta.url), "utf8");
    const child = readFileSync(new URL("../src/components/desktop/sidebar/SidebarChildRoom.vue", import.meta.url), "utf8");
    assert.match(switcher, /<RoomUnreadBadge :count="option\.entry\.unreadCount \|\| 0" :mention-count="option\.entry\.mentionCount \|\| 0" :marked-unread="option\.entry\.hasUnread" \/>/);
    assert.match(child, /<RoomUnreadBadge :count="entry\.unreadCount \|\| 0" :mention-count="entry\.mentionCount \|\| 0" :marked-unread="entry\.hasUnread" \/>/);
  });

  it("group and overflow badges carry the mention total of the rooms they count", () => {
    assert.match(
      sidebarSource,
      /function unreadBadgeProps\(unread: SidebarUnreadTotal\): UnreadBadgeProps \{\s*return \{ count: unread\.count, mentionCount: unread\.mentionCount,/,
    );
  });
});
