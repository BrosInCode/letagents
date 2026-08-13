import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { DesktopUpdateStatus } from "../../electron/ipc-types";
import {
  desktopUpdatePresentation,
  desktopUpdateSidebarPresentation,
  formatUpdateBytes,
} from "../src/domain/desktop-update-status";

function status(overrides: Partial<DesktopUpdateStatus> = {}): DesktopUpdateStatus {
  return {
    phase: "idle",
    currentVersion: "0.1.0",
    availableVersion: null,
    releaseName: null,
    releaseNotes: null,
    downloadProgress: null,
    lastCheckedAt: null,
    error: null,
    unsupportedReason: null,
    canCheck: true,
    canInstall: false,
    ...overrides,
  };
}

test("update presentation explains that downloads do not interrupt work", () => {
  const presentation = desktopUpdatePresentation(status({
    phase: "downloading",
    availableVersion: "0.2.0",
    canCheck: false,
    downloadProgress: { percent: 25, transferred: 25 * 1024 * 1024, total: 100 * 1024 * 1024, bytesPerSecond: 2 * 1024 * 1024 },
  }));
  assert.equal(presentation.title, "Downloading LetAgents 0.2.0");
  assert.match(presentation.detail, /keep working/i);
  assert.match(presentation.detail, /25 MB of 100 MB · 2\.0 MB\/s/);
});

test("sidebar turns the settings row into a compact live transfer instrument", () => {
  const downloading = desktopUpdateSidebarPresentation(status({
    phase: "downloading",
    availableVersion: "0.2.0",
    downloadProgress: { percent: 37.5, transferred: 39_321_600, total: 104_857_600, bytesPerSecond: 3_145_728 },
  }));
  assert.deepEqual(downloading, {
    active: true,
    title: "Downloading v0.2.0",
    detail: "38 MB of 100 MB · 3.0 MB/s",
    percent: 37.5,
    state: "downloading",
  });
  assert.equal(formatUpdateBytes(1_572_864), "1.5 MB");
});

test("sidebar update presentation stays inactive for routine checks and becomes the restart action when ready", () => {
  assert.equal(desktopUpdateSidebarPresentation(status({ phase: "checking" })).active, false);
  assert.deepEqual(desktopUpdateSidebarPresentation(status({
    phase: "ready",
    availableVersion: "0.2.0",
    canInstall: true,
  })), {
    active: true,
    title: "Update ready",
    detail: "v0.2.0 · Restart to install",
    percent: 100,
    state: "ready",
  });
});

test("ready update names the version and a failed safe restart remains retryable", () => {
  const ready = desktopUpdatePresentation(status({
    phase: "ready",
    availableVersion: "0.2.0",
    releaseName: "LetAgents 0.2.0",
    canCheck: false,
    canInstall: true,
  }));
  assert.match(ready.title, /0\.2\.0/);
  assert.match(ready.detail, /Restart when convenient/);

  const failedHandoff = desktopUpdatePresentation(status({
    phase: "ready",
    canCheck: false,
    canInstall: true,
    error: "Supervisor did not release its socket.",
  }));
  assert.equal(failedHandoff.tone, "warning");
  assert.match(failedHandoff.detail, /still downloaded/);
});

test("installing presentation describes the supervisor handoff", () => {
  const presentation = desktopUpdatePresentation(status({ phase: "installing", canCheck: false }));
  assert.match(presentation.title, /safe restart/i);
  assert.match(presentation.detail, /supervisor dispatch/i);
});

test("update progress does not churn an atomic live region or claim account navigation state", async () => {
  const [updatesPane, sidebar] = await Promise.all([
    readFile(new URL("../src/components/desktop/settings/panes/SettingsUpdatesPane.vue", import.meta.url), "utf8"),
    readFile(new URL("../src/components/desktop/sidebar/DesktopSidebar.vue", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(updatesPane, /class="settings-update-card"[\s\S]{0,160}role="status"/);
  assert.match(
    updatesPane,
    /<h2 role="status" aria-live="polite" aria-atomic="true">\{\{ presentation\.title \}\}<\/h2>/,
  );
  assert.match(sidebar, /v-if="updatePresentation\.active"[\s\S]{0,320}data-testid="sidebar-update-status"/);
  assert.doesNotMatch(sidebar, /:aria-current="!updatePresentation\.active/);
});
