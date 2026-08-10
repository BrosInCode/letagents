import assert from "node:assert/strict";
import test from "node:test";

import type { DesktopUpdateStatus } from "../../electron/ipc-types";
import { desktopUpdatePresentation } from "../src/domain/desktop-update-status";

function status(overrides: Partial<DesktopUpdateStatus> = {}): DesktopUpdateStatus {
  return {
    phase: "idle",
    currentVersion: "0.1.0",
    availableVersion: null,
    releaseName: null,
    releaseNotes: null,
    lastCheckedAt: null,
    error: null,
    unsupportedReason: null,
    canCheck: true,
    canInstall: false,
    ...overrides,
  };
}

test("update presentation explains that downloads do not interrupt work", () => {
  const presentation = desktopUpdatePresentation(status({ phase: "downloading", canCheck: false }));
  assert.equal(presentation.title, "Downloading the update");
  assert.match(presentation.detail, /keep working/i);
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
