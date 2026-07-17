import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const modalSource = readFileSync(fileURLToPath(new URL(
  "../src/components/desktop/content/DesktopAgentDetailModal.vue",
  import.meta.url,
)), "utf8");

test("the supervised modal exposes a dedicated destructive Stop agent zone", () => {
  assert.match(modalSource, /import \{[\s\S]*supervisedStopAgentButtonLabel[\s\S]*\} from "\.\.\/\.\.\/\.\.\/domain\/supervised-stop"/);
  assert.match(modalSource, /data-testid="desktop-agent-detail-stop-agent-zone"/);
  assert.match(modalSource, /data-testid="desktop-agent-detail-stop-agent"/);
});

test("Stop agent is confirm-gated (two-step) and cancellable", () => {
  assert.match(modalSource, /data-testid="desktop-agent-detail-stop-agent-confirm"/);
  assert.match(modalSource, /data-testid="desktop-agent-detail-stop-agent-cancel"/);
  assert.match(modalSource, /stopAgentConfirmEntryId\.value = entry\.id/);
  assert.match(modalSource, /stopAgentConfirmEntryId\.value = null/);
});

test("Stop agent retires exactly the row entry via desired_state=stopped", () => {
  assert.match(modalSource, /async function confirmStopSupervisedAgent\(id: string\)/);
  assert.match(modalSource, /setDesiredState\(id, "stopped"\)/);
  // The exact-entry id from the v-for row drives the confirm; no display-name lookup.
  assert.match(modalSource, /@click="confirmStopSupervisedAgent\(entry\.id\)"/);
});

test("Stop agent is distinct from Stop turn, not an adjacent plain lifecycle button", () => {
  // The old confusable plain Stop in the Run/Pause/Stop trio is gone.
  assert.doesNotMatch(modalSource, /setSupervisorDesiredState\(entry\.id, 'stopped'\)/);
  // Copy makes the distinction explicit.
  assert.match(modalSource, /not the same as stopping the current turn/i);
});

test("Stop agent is idempotent-guarded and works while a stop is in flight", () => {
  assert.match(modalSource, /supervisedStopAgentDisabled\(entry\)/);
  assert.match(modalSource, /stoppingSupervisorEntryId/);
});

test("a failed stop surfaces an honest error and a direct retry (no confirm loop)", () => {
  assert.match(modalSource, /supervisedStopAgentFailed/);
  assert.match(modalSource, /data-testid="desktop-agent-detail-stop-agent-error"/);
  assert.match(modalSource, /function onStopAgentPrimary/);
  // Retry re-issues the stop directly; a fresh stop still asks for confirm.
  assert.match(modalSource, /if \(supervisedStopAgentFailed\(entry\)\) \{\s*void confirmStopSupervisedAgent\(entry\.id\)/);
  assert.match(modalSource, /@click="onStopAgentPrimary\(entry\)"/);
});
