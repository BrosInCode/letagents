import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import {
  desktopLinkScheme, desktopProductName, isIsolatedDesktopPreview, normalizeDesktopPreviewLink,
} from "../main/preview-mode.js";

test("normal startup keeps its identity and never opts into preview through environment variables", () => {
  const previous = process.env.LETAGENTS_DESKTOP_ISOLATED_PREVIEW;
  process.env.LETAGENTS_DESKTOP_ISOLATED_PREVIEW = "1";
  try {
    assert.equal(isIsolatedDesktopPreview(), false);
    assert.equal(desktopProductName(), "LetAgents");
    assert.equal(desktopLinkScheme(), "letagents");
    assert.equal(normalizeDesktopPreviewLink("letagents-preview://company/1"), "letagents-preview://company/1");
  } finally {
    if (previous === undefined) delete process.env.LETAGENTS_DESKTOP_ISOLATED_PREVIEW;
    else process.env.LETAGENTS_DESKTOP_ISOLATED_PREVIEW = previous;
  }
});

test("packaged preview disables updater and APNs, avoids login shells, and owns only the preview link scheme", async () => {
  const directory = await mkdtemp(join(tmpdir(), "preview-runtime-"));
  const marker = Symbol.for("letagents.isolated-desktop-preview");
  Object.defineProperty(globalThis, marker, { value: "agent-room-refresh", configurable: true });
  const protocols: string[] = [];
  let updateCalls = 0;
  let apnsCalls = 0;
  let apiCalls = 0;
  let shellCalls = 0;
  const app = {
    isPackaged: true, getVersion: () => "0.1.138", getPath: () => directory,
    isReady: () => true, on() {}, quit() {}, setBadgeCount() {},
    setAsDefaultProtocolClient: (scheme: string) => { protocols.push(scheme); },
  };
  const autoUpdater = { on() {} };
  mock.module("electron", { defaultExport: {
    app, autoUpdater,
    Notification: { getHistory: async () => { apnsCalls += 1; return []; }, isSupported: () => false },
    pushNotifications: {
      on() { apnsCalls += 1; },
      registerForAPNSNotifications: async () => { apnsCalls += 1; return "must-not-register"; },
      unregisterForAPNSNotifications() { apnsCalls += 1; },
    },
  }, namedExports: { app, autoUpdater } });
  mock.module("electron-updater", { defaultExport: { autoUpdater: {
    checkForUpdates: async () => { updateCalls += 1; return null; },
    setFeedURL() { updateCalls += 1; },
    downloadUpdate: async () => { updateCalls += 1; },
    quitAndInstall() { updateCalls += 1; },
    on() { updateCalls += 1; },
  } } });
  mock.module("../main/auth.js", { namedExports: { apiFetch: async () => { apiCalls += 1; return {}; } } });
  mock.module("../main/window.js", { namedExports: { createWindow() {}, focusMainWindow() {}, hasOpenWindows: () => true, emitToMainWindow() {} } });
  mock.module("../main/supervisor-daemon.js", { namedExports: { supervisorDaemonClient: {} } });
  mock.module("../main/supervisor-grant-coordinator.js", { namedExports: { supervisorGrantCoordinator: {} } });
  try {
    const updates = await import("../main/updates.js");
    updates.initializeDesktopUpdates();
    assert.equal((await updates.desktopUpdater.check()).phase, "unsupported");
    assert.equal((await updates.desktopUpdater.install()).phase, "unsupported");
    assert.match(updates.desktopUpdater.getStatus().unsupportedReason ?? "", /isolated preview/);
    assert.equal(updateCalls, 0);

    const notifications = await import("../main/notifications.js");
    notifications.prepareDesktopNotifications();
    await notifications.setDesktopNotificationsEnabled(true);
    await notifications.setDesktopNotificationsEnabled(false);
    await notifications.unregisterDesktopNotificationAccount();
    assert.equal((await notifications.getDesktopNotificationStatus()).nativeSupported, false);
    assert.equal(apnsCalls, 0);
    assert.equal(apiCalls, 0);

    const shell = await import("../main/desktop-shell-environment.js");
    shell.resetDesktopShellEnvironmentForTests();
    const env = { HOME: "/isolated/home", PATH: "/installed/bin:/usr/bin" };
    const hydrated = await shell.hydrateDesktopShellEnvironment({ env, runCommand: async () => { shellCalls += 1; throw new Error("must not source shell"); } });
    assert.deepEqual(hydrated.environment, env);
    assert.equal(shellCalls, 0);
    shell.resetDesktopShellEnvironmentForTests();

    const links = await import("../main/ask-links.js");
    links.registerAskLinks();
    assert.deepEqual(protocols, ["letagents-preview"]);
    assert.deepEqual(links.parseDesktopLink("letagents-preview://ask/abcdefghijklmnopqrst"), { kind: "ask", token: "abcdefghijklmnopqrst" });
    const companies = await import("../main/company-links.js");
    companies.acceptCompanyLink("letagents-preview://company/42");
    assert.equal(companies.getPendingCompanyLink(), "42");
    assert.deepEqual(JSON.parse(await readFile(join(directory, "pending-company-link.json"), "utf8")), { organizationId: "42" });
    assert.equal(desktopProductName(), "LetAgents Preview");
  } finally {
    Reflect.deleteProperty(globalThis, marker);
    mock.restoreAll();
    await rm(directory, { recursive: true, force: true });
  }
});
