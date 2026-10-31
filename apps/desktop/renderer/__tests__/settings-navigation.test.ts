import assert from "node:assert/strict";
import test from "node:test";
import {
  filterSettingsNavigation,
  lastSettingsPane,
  legacySettingsPaneRedirects,
  reopenedSettingsPane,
  resolveSettingsPane,
  settingsNavGroups,
  settingsSectionFor,
  settingsSubsectionFor,
  settingsSubsections,
  visibleSettingsSubsections,
} from "../src/components/desktop/settings/navigation.js";

test("every existing settings pane is reachable from the grouped navigation", () => {
  const all = new Set(settingsNavGroups.flatMap(group => group.items.flatMap(item =>
    (settingsSubsections[item.id] ?? [item]).map(child => child.id))));
  assert.equal(all.size, 18);
  for (const pane of all) {
    const section = settingsSectionFor(pane);
    assert.ok(settingsNavGroups.some(group => group.items.some(item => item.id === section)));
  }
  assert.equal(settingsSectionFor("system:supervisor"), "system:diagnostics");
  assert.equal(settingsSectionFor("storage:database"), "storage:chat");
  assert.equal(settingsSectionFor("account:connectors-remote"), "account:connectors");
});

test("trackers, agent apps and remote sign-ins are one Connectors page under You", () => {
  const titles = settingsNavGroups.map(group => [group.label, group.items.map(item => item.title)]);
  assert.deepEqual(titles, [
    ["You", ["Account", "Renting", "Connectors"]],
    ["Workspace", ["Rooms", "Storage", "Agents"]],
    ["Application", ["Assistant", "Updates", "Troubleshooting"]],
  ], "no top-level Ticket trackers or Connections");
  assert.equal(settingsNavGroups[0]!.items[2]!.id, "account:connectors", "the old id keeps deep links working");
  assert.deepEqual(visibleSettingsSubsections("account:connectors").map(item => item.title), ["Trackers", "Agent apps", "Remote sign-ins"]);
  assert.equal(settingsSubsectionFor("account:connectors-setup"), "account:connectors-agents", "the setup flow marks Agent apps");
  assert.equal(settingsSubsectionFor("account:connectors-remote"), "account:connectors-remote");
});

test("old Connections pane ids open their place on the Connectors page", () => {
  assert.deepEqual(legacySettingsPaneRedirects, {
    "system:mcp": "account:connectors-agents",
    "system:setup": "account:connectors-setup",
    "system:remote-mcp": "account:connectors-remote",
  });
  for (const [legacy, pane] of Object.entries(legacySettingsPaneRedirects)) {
    assert.equal(resolveSettingsPane(legacy as keyof typeof legacySettingsPaneRedirects), pane);
    assert.equal(settingsSectionFor(pane), "account:connectors");
  }
  assert.equal(resolveSettingsPane("account:connectors"), "account:connectors");
  assert.equal(resolveSettingsPane("system:updates"), "system:updates");
});

test("settings search reaches nested recovery and publishing panes without duplicate results", () => {
  const ids = (query: string) => filterSettingsNavigation(query).flatMap(group => group.items.map(item => item.id));
  assert.deepEqual(ids("credential recovery"), ["system:supervisor"]);
  assert.deepEqual(ids("attachments"), ["storage:database"]);
  assert.deepEqual(ids("publish local"), ["storage:sync"]);
  assert.deepEqual(ids(" CONNECT an AGENT app "), ["account:connectors-setup"]);
  assert.deepEqual(ids("no such preference"), []);
  assert.equal(ids("").length, 9);
  assert.deepEqual(ids("jira"), ["account:connectors"]);
  assert.deepEqual(ids("github issues"), ["account:connectors"]);
  assert.deepEqual(ids("remote"), ["account:connectors-remote"]);
  assert.deepEqual(ids("connectors"), ["account:connectors"]);
});

test("plain Settings reopens the pane shown last, and Chat storage the first time", () => {
  const previous = lastSettingsPane.value;
  try {
    lastSettingsPane.value = null;
    assert.equal(reopenedSettingsPane(), "storage:chat");
    lastSettingsPane.value = "account:connectors";
    assert.equal(reopenedSettingsPane(), "account:connectors");
    lastSettingsPane.value = "account:connectors-setup";
    assert.equal(reopenedSettingsPane(), "account:connectors-agents", "a hidden setup pane reopens at its parent");
  } finally {
    lastSettingsPane.value = previous;
  }
});

test("choosing a hidden pane inside open Settings stays there, and reopening goes to its parent", async () => {
  const { effectScope, nextTick, ref, watch } = await import("vue");
  const { useAppSettingsPaneWatcher, useAppSidebarLayout } = await import("../src/composables/app/useAppSidebarLayout.js");
  const { settingsEntry } = await import("../src/domain/desktop-navigation.js");
  const previous = lastSettingsPane.value;
  const scope = effectScope();
  try {
    lastSettingsPane.value = null;
    const roomEntry = { type: "room", id: "room:acme" };
    const app = { activeEntry: ref<unknown>(roomEntry), requestedSettingsPane: ref(null), sidebarMode: ref("expanded") };
    scope.run(() => {
      const layout = useAppSidebarLayout(app);
      Object.assign(app, layout);
      useAppSettingsPaneWatcher(app);
      layout.openSettingsSurface();
      // SettingsView's own chain: the initial pane prop sets the pane, and the pane is remembered.
      const activePane = ref(layout.settingsPaneForActiveEntry.value);
      watch(layout.settingsPaneForActiveEntry, (pane) => { activePane.value = pane; });
      watch(activePane, (pane) => { lastSettingsPane.value = pane; }, { immediate: true });
      Object.assign(app, { layout, activePane });
    });
    const { layout, activePane } = app as unknown as {
      layout: ReturnType<typeof useAppSidebarLayout>;
      activePane: { value: string };
    };
    assert.equal(activePane.value, "storage:chat");
    activePane.value = "account:connectors-setup";
    await nextTick();
    await nextTick();
    assert.equal(activePane.value, "account:connectors-setup", "Set up is not sent back to Chat storage");
    app.activeEntry.value = roomEntry;
    app.activeEntry.value = settingsEntry;
    assert.equal(layout.settingsPaneForActiveEntry.value, "account:connectors-agents");
  } finally {
    scope.stop();
    lastSettingsPane.value = previous;
  }
});
