import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const app = readFileSync(new URL("../src/App.vue", import.meta.url), "utf8");

describe("archived active room check", () => {
  it("re-runs when the active room changes, not only when the room list changes", () => {
    // The room list keeps its identity on an unchanged poll, so the watcher
    // must also watch the active room's aliases.
    const start = app.indexOf("() => settingsAccountRooms.value,");
    assert.ok(start > 0);
    const watcher = app.slice(start, app.indexOf("leaveArchivedSelectedRoomFromSettingsList();", start));
    assert.match(watcher, /currentActiveRoomAliases\(\)/);
  });
});
