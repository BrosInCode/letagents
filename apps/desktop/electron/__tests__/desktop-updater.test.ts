import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HttpError } from "builder-util-runtime";

import {
  DesktopUpdaterController,
  desktopUpdateFeedBaseUrl,
  isRetryableUpdateTransportError,
  versionFromReleaseName,
} from "../main/desktop-updater.js";
import { DesktopUpdateDiagnosticLog } from "../main/update-diagnostics.js";

function controller(overrides: Partial<ConstructorParameters<typeof DesktopUpdaterController>[0]> = {}) {
  const events: string[] = [];
  const statuses: string[] = [];
  const updater = new DesktopUpdaterController({
    currentVersion: "0.1.0",
    supported: true,
    checkForUpdates: async () => { events.push("check"); return { isUpdateAvailable: false }; },
    downloadUpdate: async () => { events.push("download"); },
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
    checkForUpdates: async () => { checks += 1; return { isUpdateAvailable: false }; },
  });
  assert.deepEqual(updater.getStatus(), {
    phase: "unsupported",
    currentVersion: "0.1.0",
    availableVersion: null,
    releaseName: null,
    releaseNotes: null,
    updateSize: null,
    downloadProgress: null,
    lastCheckedAt: null,
    error: null,
    failureStage: null,
    downloadAttempt: null,
    downloadAttemptLimit: null,
    unsupportedReason: "Production builds only.",
    canCheck: false,
    canInstall: false,
  });
  await updater.check();
  assert.equal(checks, 0);
});

test("desktop updater distinguishes a feed check failure from a download failure", async () => {
  const { updater } = controller({
    checkForUpdates: async () => { throw new Error("missing app-update.yml"); },
  });

  const status = await updater.check();
  assert.equal(status.phase, "error");
  assert.equal(status.failureStage, "check");
  assert.match(status.error || "", /missing app-update\.yml/);
});

test("desktop updater retries a transient feed check without starting a download early", async () => {
  let checks = 0;
  let downloads = 0;
  const delays: number[] = [];
  const { updater } = controller({
    checkForUpdates: async () => {
      checks += 1;
      if (checks === 1) throw new Error("net::ERR_CONNECTION_CLOSED");
      return { isUpdateAvailable: true, version: "0.2.0", total: 200 };
    },
    downloadUpdate: async () => { downloads += 1; },
    retryDelayMs: () => 25,
    sleep: async (delay) => { delays.push(delay); },
  });

  const status = await updater.check();
  assert.equal(status.phase, "ready");
  assert.equal(checks, 2);
  assert.equal(downloads, 1);
  assert.deepEqual(delays, [25]);
});

test("a synchronously emitted updater error is classified once by its owning check", async () => {
  let updater!: DesktopUpdaterController;
  const diagnostics: string[] = [];
  ({ updater } = controller({
    checkForUpdates: async () => {
      const eventStatus = await updater.fail(new Error("missing feed"));
      assert.equal(eventStatus.phase, "checking");
      throw new Error("missing feed");
    },
    diagnostic: (event) => { diagnostics.push(event.event); },
  }));

  const status = await updater.check();
  assert.equal(status.phase, "error");
  assert.equal(status.failureStage, "check");
  assert.equal(diagnostics.filter((event) => event === "check_failed").length, 1);
});

test("desktop updater retries transient download failures and keeps the signed archive size", async () => {
  let downloads = 0;
  const delays: number[] = [];
  const diagnostics: string[] = [];
  const { updater } = controller({
    checkForUpdates: async () => ({
      isUpdateAvailable: true,
      version: "0.2.0",
      releaseName: "LetAgents 0.2.0",
      total: 200 * 1024 * 1024,
    }),
    downloadUpdate: async () => {
      downloads += 1;
      if (downloads < 3) throw new Error("net::ERR_CONNECTION_CLOSED");
    },
    retryDelayMs: (attempt) => attempt * 10,
    sleep: async (delay) => { delays.push(delay); },
    diagnostic: (event) => { diagnostics.push(event.event); },
  });

  const status = await updater.check();
  assert.equal(status.phase, "ready");
  assert.equal(status.updateSize, 200 * 1024 * 1024);
  assert.equal(status.failureStage, null);
  assert.equal(downloads, 3);
  assert.deepEqual(delays, [20, 30]);
  assert.equal(diagnostics.filter((event) => event === "download_retry_scheduled").length, 2);
  assert.equal(diagnostics.at(-1), "download_completed");
});

test("desktop updater does not present the full archive size as transfer progress", async () => {
  let updater!: DesktopUpdaterController;
  const statusesBeforeProgress: Array<ReturnType<DesktopUpdaterController["getStatus"]>> = [];
  ({ updater } = controller({
    checkForUpdates: async () => ({
      isUpdateAvailable: true,
      version: "0.2.0",
      total: 200 * 1024 * 1024,
    }),
    downloadUpdate: async () => { statusesBeforeProgress.push(updater.getStatus()); },
  }));

  await updater.check();
  assert.equal(statusesBeforeProgress[0]?.updateSize, 200 * 1024 * 1024);
  assert.equal(statusesBeforeProgress[0]?.downloadProgress, null);
});

test("desktop updater does not retry integrity failures and leaves download retryable", async () => {
  let downloads = 0;
  const { updater } = controller({
    checkForUpdates: async () => ({ isUpdateAvailable: true, version: "0.2.0", total: 200 }),
    downloadUpdate: async () => { downloads += 1; throw new Error("sha512 checksum mismatch"); },
    sleep: async () => { throw new Error("non-transport failures must not sleep"); },
  });

  const status = await updater.check();
  assert.equal(status.phase, "error");
  assert.equal(status.failureStage, "download");
  assert.equal(status.canCheck, true);
  assert.equal(status.updateSize, 200);
  assert.equal(downloads, 1);
});

test("transport retry classification is narrow", () => {
  assert.equal(isRetryableUpdateTransportError(new Error("net::ERR_CONNECTION_CLOSED")), true);
  assert.equal(isRetryableUpdateTransportError(new Error("read ECONNRESET")), true);
  assert.equal(isRetryableUpdateTransportError(new HttpError(503)), true);
  assert.equal(isRetryableUpdateTransportError(new HttpError(404)), false);
  assert.equal(isRetryableUpdateTransportError(new Error('Cannot download "https://downloads.example/update.zip", status 503: Service Unavailable')), true);
  assert.equal(isRetryableUpdateTransportError(new Error("Request timed out")), true);
  assert.equal(isRetryableUpdateTransportError(new Error("Request has been aborted by the server")), true);
  assert.equal(isRetryableUpdateTransportError(new Error("response has been aborted by the server")), true);
  assert.equal(isRetryableUpdateTransportError(new Error("sha512 checksum mismatch")), false);
  assert.equal(isRetryableUpdateTransportError(new Error("HTTP status 404")), false);
});

test("desktop updater diagnostics are private, redacted, bounded, and best effort", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-update-log-"));
  try {
    const path = join(root, "private", "desktop-updater.jsonl");
    const log = new DesktopUpdateDiagnosticLog(path, {
      currentVersion: "0.1.0",
      arch: "arm64",
      feedUrl: "https://user:secret@downloads.letagents.chat/desktop/feeds/arm64/?signature=feed-secret",
    }, 2_048);
    for (let index = 0; index < 20; index += 1) {
      log.append({
        event: "download_failed",
        stage: "download",
        attempt: 3,
        attemptLimit: 3,
        detail: `authorization=Bearer ghp_abcdefghijklmnopqrstuvwxyz1234567890 https://downloads.letagents.chat/update.zip?signature=asset-secret ${"x".repeat(400)} ${index}`,
      });
    }
    log.close();

    const names = (await readdir(join(root, "private"))).sort();
    assert.deepEqual(names, ["desktop-updater.jsonl", "desktop-updater.jsonl.previous"]);
    for (const name of names) {
      const file = join(root, "private", name);
      assert.ok((await stat(file)).size <= 2_048);
      const contents = await readFile(file, "utf8");
      assert.doesNotMatch(contents, /ghp_/);
      assert.doesNotMatch(contents, /secret|signature/i);
      assert.match(contents, /https:\/\/downloads\.letagents\.chat\//);
      assert.match(contents, /\[REDACTED\]/);
      assert.equal((await stat(file)).mode & 0o777, 0o600);
    }
    assert.equal((await stat(join(root, "private"))).mode & 0o777, 0o700);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop updater tracks background download and release metadata", async () => {
  const { updater, events, statuses } = controller();
  await updater.check();
  updater.markAvailable({ version: "0.2.0", total: 1000 });
  updater.markDownloadProgress({ percent: 42.5, transferred: 425, total: 1000, bytesPerSecond: 125 });
  updater.markDownloaded({ releaseName: "LetAgents 0.2.0", releaseNotes: "Safer updates" });
  assert.deepEqual(events, ["check"]);
  assert.deepEqual(statuses, ["checking", "up-to-date", "downloading", "downloading", "ready"]);
  assert.deepEqual(updater.getStatus(), {
    phase: "ready",
    currentVersion: "0.1.0",
    availableVersion: "0.2.0",
    releaseName: "LetAgents 0.2.0",
    releaseNotes: "Safer updates",
    updateSize: 1000,
    downloadProgress: {
      percent: 100,
      transferred: 1000,
      total: 1000,
      bytesPerSecond: 125,
    },
    lastCheckedAt: "2026-08-10T12:00:00.000Z",
    error: null,
    failureStage: null,
    downloadAttempt: null,
    downloadAttemptLimit: null,
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

test("asynchronous native staging failure restores supervision once and keeps the update retryable", async () => {
  let releaseRecovery!: () => void;
  const recoveryGate = new Promise<void>((resolve) => { releaseRecovery = resolve; });
  const { updater, events } = controller({
    recoverAfterInstallFailure: async () => {
      events.push("recover");
      await recoveryGate;
    },
  });
  updater.markDownloaded({ releaseName: "LetAgents 0.2.0" });
  const installing = await updater.install();
  assert.equal(installing.phase, "installing");

  const firstFailure = updater.fail(new Error("native staging failed"));
  const duplicateFailure = updater.fail(new Error("duplicate native error"));
  assert.deepEqual(events, ["handoff", "install", "recover"]);
  releaseRecovery();

  const [firstStatus, duplicateStatus] = await Promise.all([firstFailure, duplicateFailure]);
  assert.equal(firstStatus.phase, "ready");
  assert.equal(duplicateStatus.phase, "ready");
  assert.equal(firstStatus.canInstall, true);
  assert.match(firstStatus.error || "", /native staging failed/);
  assert.deepEqual(events, ["handoff", "install", "recover"]);

  const lateDuplicate = await updater.fail(new Error("late duplicate native error"));
  assert.equal(lateDuplicate.phase, "ready");
  assert.match(lateDuplicate.error || "", /native staging failed/);
  assert.deepEqual(events, ["handoff", "install", "recover"]);
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
