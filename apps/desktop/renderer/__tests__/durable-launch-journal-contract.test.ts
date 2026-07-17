import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const modalSource = readFileSync(fileURLToPath(new URL(
  "../src/components/desktop/content/AddAgentModal.vue",
  import.meta.url,
)), "utf8");
const ipcSource = readFileSync(fileURLToPath(new URL(
  "../../electron/main/ipc.ts",
  import.meta.url,
)), "utf8");
const launchEventsSource = readFileSync(fileURLToPath(new URL(
  "../../electron/main/launch-events.ts",
  import.meta.url,
)), "utf8");

test("the modal consumes a daemon-driven journal subscription and keeps replay-on-open", () => {
  assert.match(modalSource, /desktopIpc\.supervisor\.onLaunchEvent\?\.\(\(event\) =>/);
  assert.match(modalSource, /void replayLaunchEvents\(launchId\)/, "reopen must repair from durable history");
  assert.match(ipcSource, /supervisorDaemonClient\.waitLaunchEvents\(launchId, cursor\)/);
  assert.match(launchEventsSource, /reconcileLaunchEvents\(\[\.\.\.getLaunchEvents\(launchId\), \.\.\.durable\]\)/);
  const refreshStart = modalSource.indexOf("function startSupervisedRuntimeRefresh");
  const refreshEnd = modalSource.indexOf("\nfunction stopSupervisedRuntimeRefreshTimer", refreshStart);
  const runtimeRefresh = modalSource.slice(refreshStart, refreshEnd);
  assert.doesNotMatch(runtimeRefresh, /replayLaunchEvents\(/, "journal delivery must not depend on manifest polling");
});
