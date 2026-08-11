import assert from "node:assert/strict";
import test from "node:test";

import {
  DesktopUpdaterController,
  desktopUpdateFeedBaseUrl,
  versionFromReleaseName,
} from "../main/desktop-updater.js";

function controller(overrides: Partial<ConstructorParameters<typeof DesktopUpdaterController>[0]> = {}) {
  const events: string[] = [];
  const statuses: string[] = [];
  const updater = new DesktopUpdaterController({
    currentVersion: "0.1.0",
    supported: true,
    checkForUpdates: () => { events.push("check"); },
    prepareForInstall: async () => { events.push("handoff"); },
    quitAndInstall: () => { events.push("install"); },
    publish: (status) => { statuses.push(status.phase); },
    now: () => new Date("2026-08-10T12:00:00.000Z"),
    ...overrides,
  });
  return { updater, events, statuses };
}

test("desktop updater exposes a truthful unsupported state without touching the update feed", async () => {
  let checks = 0;
  const { updater } = controller({
    supported: false,
    unsupportedReason: "Production builds only.",
    checkForUpdates: () => { checks += 1; },
  });
  assert.deepEqual(updater.getStatus(), {
    phase: "unsupported",
    currentVersion: "0.1.0",
    availableVersion: null,
    releaseName: null,
    releaseNotes: null,
    lastCheckedAt: null,
    error: null,
    unsupportedReason: "Production builds only.",
    canCheck: false,
    canInstall: false,
  });
  await updater.check();
  assert.equal(checks, 0);
});

test("desktop updater tracks background download and release metadata", async () => {
  const { updater, events, statuses } = controller();
  await updater.check();
  updater.markAvailable();
  updater.markDownloaded({ releaseName: "LetAgents 0.2.0", releaseNotes: "Safer updates" });
  assert.deepEqual(events, ["check"]);
  assert.deepEqual(statuses, ["checking", "downloading", "ready"]);
  assert.deepEqual(updater.getStatus(), {
    phase: "ready",
    currentVersion: "0.1.0",
    availableVersion: "0.2.0",
    releaseName: "LetAgents 0.2.0",
    releaseNotes: "Safer updates",
    lastCheckedAt: "2026-08-10T12:00:00.000Z",
    error: null,
    unsupportedReason: null,
    canCheck: false,
    canInstall: true,
  });
});

test("desktop updater proves daemon handoff before invoking Squirrel installation", async () => {
  const { updater, events } = controller();
  updater.markDownloaded({ releaseName: "LetAgents 0.2.0" });
  const status = await updater.install();
  assert.deepEqual(events, ["handoff", "install"]);
  assert.equal(status.phase, "installing");
  assert.equal(status.canCheck, false);
  assert.equal(status.canInstall, false);
});

test("failed daemon handoff keeps the downloaded update retryable and never quits", async () => {
  const { updater, events } = controller({
    prepareForInstall: async () => {
      events.push("handoff");
      throw new Error("daemon still owns its socket");
    },
  });
  updater.markDownloaded({ releaseName: "LetAgents 0.2.0" });
  const status = await updater.install();
  assert.deepEqual(events, ["handoff"]);
  assert.equal(status.phase, "ready");
  assert.equal(status.canInstall, true);
  assert.match(status.error || "", /still owns its socket/);
});

test("Squirrel launch failure restarts supervision after a completed handoff", async () => {
  const { updater, events } = controller({
    recoverAfterInstallFailure: async () => { events.push("recover"); },
    quitAndInstall: () => {
      events.push("install");
      throw new Error("Squirrel could not relaunch");
    },
  });
  updater.markDownloaded({ releaseName: "LetAgents 0.2.0" });
  const status = await updater.install();
  assert.deepEqual(events, ["handoff", "install", "recover"]);
  assert.equal(status.phase, "ready");
  assert.match(status.error || "", /could not relaunch/);
});

test("release version parsing accepts stable and prerelease names", () => {
  assert.equal(versionFromReleaseName("LetAgents 2.4.1"), "2.4.1");
  assert.equal(versionFromReleaseName("v2.4.1-beta.2"), "2.4.1-beta.2");
  assert.equal(versionFromReleaseName("August desktop release"), null);
});

test("desktop update feeds are architecture-specific and never use releases/latest", () => {
  assert.equal(
    desktopUpdateFeedBaseUrl("arm64"),
    "https://downloads.letagents.chat/desktop/feeds/arm64",
  );
  assert.equal(
    desktopUpdateFeedBaseUrl("x64"),
    "https://downloads.letagents.chat/desktop/feeds/x64",
  );
  assert.equal(desktopUpdateFeedBaseUrl("ia32"), null);
});
