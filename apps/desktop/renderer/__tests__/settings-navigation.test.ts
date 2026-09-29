import assert from "node:assert/strict";
import test from "node:test";
import { filterSettingsNavigation, settingsNavGroups, settingsSectionFor, settingsSubsections } from "../src/components/desktop/settings/navigation.js";

test("every existing settings pane is reachable from the grouped navigation", () => {
  const all = new Set(settingsNavGroups.flatMap(group => group.items.flatMap(item =>
    (settingsSubsections[item.id] ?? [item]).map(child => child.id))));
  assert.equal(all.size, 16);
  for (const pane of all) {
    const section = settingsSectionFor(pane);
    assert.ok(settingsNavGroups.some(group => group.items.some(item => item.id === section)));
  }
  assert.equal(settingsSectionFor("system:supervisor"), "system:diagnostics");
  assert.equal(settingsSectionFor("storage:database"), "storage:chat");
});

test("settings search reaches nested recovery and publishing panes without duplicate results", () => {
  const ids = (query: string) => filterSettingsNavigation(query).flatMap(group => group.items.map(item => item.id));
  assert.deepEqual(ids("credential recovery"), ["system:supervisor"]);
  assert.deepEqual(ids("attachments"), ["storage:database"]);
  assert.deepEqual(ids("publish local"), ["storage:sync"]);
  assert.deepEqual(ids(" CONNECT an APP "), ["system:setup"]);
  assert.deepEqual(ids("no such preference"), []);
  assert.equal(ids("").length, 9);
});
