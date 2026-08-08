import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const appSource = source("../src/App.vue");
const sidebarSource = source("../src/components/desktop/sidebar/DesktopSidebar.vue");
const dialogSource = source("../src/components/desktop/sidebar/SidebarFocusRoomConclusionDialog.vue");
const settingsSource = source("../src/composables/useDesktopAccountRoomSettings.ts");
const mainFocusRoomsSource = source("../../electron/main/rooms/focus-rooms.ts");

describe("desktop sidebar focus room conclusion contract", () => {
  it("wires the context action through the sidebar and app-owned dialog", () => {
    assert.match(sidebarSource, /"conclude-focus-room": \[entry: RoomEntry\]/);
    assert.match(sidebarSource, /emit\("conclude-focus-room", menu\.entry\)/);
    assert.match(appSource, /@conclude-focus-room="openSidebarFocusRoomConclusion"/);
    assert.match(appSource, /<SidebarFocusRoomConclusionDialog/);
    assert.match(appSource, /@submit="submitSidebarFocusRoomConclusion"/);
  });

  it("keeps the dialog accessible and task closeout complete", () => {
    assert.match(dialogSource, /role="dialog"/);
    assert.match(dialogSource, /aria-modal="true"/);
    assert.match(dialogSource, /@keydown\.esc\.stop\.prevent="requestClose"/);
    assert.match(dialogSource, /trapFocusInDialog\(event, dialogElement\.value\)/);
    assert.match(dialogSource, /v-if="taskLinked"/);
    assert.match(dialogSource, /details\.artifact/);
    assert.match(dialogSource, /details\.next_owner/);
    assert.match(dialogSource, /details\.review_state/);
    assert.match(dialogSource, /details\.blocker_state/);
    assert.match(dialogSource, /details\.parent_task_next/);
    assert.match(dialogSource, /role="alert"/);
  });

  it("uses the existing conclusion IPC, refreshes state, and preserves retryable errors", () => {
    assert.match(settingsSource, /desktopIpc\.room\.concludeFocusRoom\(/);
    assert.match(settingsSource, /await options\.refresh\(\)/);
    assert.match(settingsSource, /return \{ ok: false, error \}/);
    assert.match(appSource, /sidebarFocusRoomConclusionError\.value = result\.error/);
    assert.match(appSource, /sidebarFocusRoomConclusionReturnFocusId\.value = parent\?\.id \|\| null/);
  });

  it("identifies the IPC mutation as an authenticated desktop-human write", () => {
    assert.match(
      mainFocusRoomsSource,
      /conclusion_details: conclusionDetails,[\s\S]*?desktop_human_client: true/,
    );
    assert.match(mainFocusRoomsSource, /"X-LetAgents-Desktop-Client": "1"/);
  });

  it("removes displacement for reduced-motion users", () => {
    assert.match(
      dialogSource,
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?transform: none;/,
    );
    assert.doesNotMatch(dialogSource, /transition:\s*all\b/);
  });
});
