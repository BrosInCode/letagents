import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const modalSource = readFileSync(fileURLToPath(new URL(
  "../src/components/desktop/content/AddAgentModal.vue",
  import.meta.url,
)), "utf8");

test("every manifest refresh replays the durable launch journal", () => {
  const runtimeRefresh = modalSource.slice(modalSource.indexOf("function startSupervisedRuntimeRefresh"));
  assert.match(
    runtimeRefresh,
    /replayLaunchEvents\(launchIdForEntry\(entryId\)\)/,
    "journal replay must survive Electron or daemon restart",
  );
});
