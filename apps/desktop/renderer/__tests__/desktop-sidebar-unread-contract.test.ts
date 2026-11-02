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

  it("single rooms keep their own count in child rows and search results", () => {
    assert.match(sidebarSource, /<RoomUnreadBadge :count="result\.entry\.unreadCount \|\| 0" :marked-unread="result\.entry\.hasUnread" \/>/);
  });
});
