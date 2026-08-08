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
const roomDetailsSource = source("../src/components/desktop/content/RoomDetailsView.vue");
const roomShellSource = source("../src/components/desktop/content/DesktopRoomShell.vue");
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

  it("routes every Room Details closeout through shared input and a full sidebar refresh", () => {
    assert.doesNotMatch(roomDetailsSource, /window\.prompt/);
    assert.doesNotMatch(roomDetailsSource, /artifact: "Manual close"/);
    assert.match(roomDetailsSource, /emit\("request-focus-room-conclusion", focusRoom\)/);
    assert.match(roomDetailsSource, /emit\("focus-room-concluded", \{/);
    assert.match(roomShellSource, /@request-focus-room-conclusion="emit\('request-focus-room-conclusion', \$event\)"/);
    assert.match(roomShellSource, /@focus-room-concluded="emit\('focus-room-concluded', \$event\)"/);
    assert.match(appSource, /@focus-room-concluded="handleRoomDetailsFocusRoomConcluded"/);
    assert.match(
      appSource,
      /async function handleRoomDetailsFocusRoomConcluded[\s\S]*?await refresh\(\)[\s\S]*?handleSidebarEntrySelected\(parentAfterRefresh\)/,
    );
  });

  it("announces a dialog result once and only after its exit animation", () => {
    const concludeAction = settingsSource.match(
      /async function concludeSidebarFocusRoom[\s\S]*?(?=\n  async function togglePinSidebarRoom)/,
    )?.[0] || "";
    assert.ok(concludeAction);
    assert.doesNotMatch(concludeAction, /reportSidebarRoomAction/);
    assert.match(dialogSource, /@after-leave="handleAfterLeave"/);
    assert.match(dialogSource, /emit\("after-leave"\)/);
    assert.match(appSource, /@after-leave="handleSidebarFocusRoomConclusionAfterLeave"/);
    assert.match(appSource, /if \(message\) pushActionToast\(message, "success"\)/);
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
