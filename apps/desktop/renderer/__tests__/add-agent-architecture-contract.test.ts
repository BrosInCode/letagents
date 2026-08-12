import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const modal = readFileSync(fileURLToPath(new URL(
  "../src/components/desktop/content/AddAgentModal.vue",
  import.meta.url,
)), "utf8");
const shell = readFileSync(fileURLToPath(new URL(
  "../src/components/desktop/content/DesktopRoomShell.vue",
  import.meta.url,
)), "utf8");
const participantSurface = readFileSync(fileURLToPath(new URL(
  "../src/components/desktop/content/agent-inspector/AgentInspectorParticipantSurface.vue",
  import.meta.url,
)), "utf8");
const providerRail = readFileSync(fileURLToPath(new URL(
  "../src/components/desktop/content/add-agent/AddAgentProviderRail.vue",
  import.meta.url,
)), "utf8");
const actionBar = readFileSync(fileURLToPath(new URL(
  "../src/components/desktop/content/add-agent/AddAgentActionBar.vue",
  import.meta.url,
)), "utf8");
const managedSessions = readFileSync(fileURLToPath(new URL(
  "../src/components/desktop/content/add-agent/AddAgentManagedSessions.vue",
  import.meta.url,
)), "utf8");
const controller = readFileSync(fileURLToPath(new URL(
  "../src/components/desktop/content/add-agent/useAddAgentController.ts",
  import.meta.url,
)), "utf8");
const setup = readFileSync(fileURLToPath(new URL(
  "../src/components/desktop/content/add-agent/useAddAgentSetup.ts",
  import.meta.url,
)), "utf8");
const presentation = readFileSync(fileURLToPath(new URL(
  "../src/components/desktop/content/add-agent/useAddAgentPresentation.ts",
  import.meta.url,
)), "utf8");
const setupStatus = readFileSync(fileURLToPath(new URL(
  "../src/components/desktop/content/add-agent/AddAgentSetupStatus.vue",
  import.meta.url,
)), "utf8");
const styles = readFileSync(fileURLToPath(new URL(
  "../src/styles/agent-management.css",
  import.meta.url,
)), "utf8");
const providerStyles = readFileSync(fileURLToPath(new URL(
  "../src/components/desktop/content/add-agent/AddAgentProviderRail.css",
  import.meta.url,
)), "utf8");
const actionStyles = readFileSync(fileURLToPath(new URL(
  "../src/components/desktop/content/add-agent/AddAgentActionBar.css",
  import.meta.url,
)), "utf8");
const managedSessionStyles = readFileSync(fileURLToPath(new URL(
  "../src/components/desktop/content/add-agent/AddAgentLiveCard.css",
  import.meta.url,
)), "utf8");

test("Add Agent modal is not a managed-session polling owner", () => {
  assert.ok(modal.split("\n").length < 250, "modal shell should stay below 250 lines");
  assert.doesNotMatch(modal, /managedSessions\s*:/);
  assert.doesNotMatch(modal, /managed-sessions-updated/);
  assert.doesNotMatch(modal, /listManagedAgentSessions/);
  assert.doesNotMatch(modal, /setInterval/);
});

test("supervised polling state is consumed only by live islands", () => {
  assert.match(modal, /:controller="supervisedUi"/);
  assert.match(modal, /:supervised="supervisedUi"/);
  for (const liveBinding of [
    "supervisedLaunchView",
    "supervisedConflict",
    "supervisedRecoveryCandidate",
    "supervisedConflictLookupError",
    "stoppingSupervisorEntryId",
  ]) {
    assert.doesNotMatch(modal, new RegExp(`\\b${liveBinding}\\b`));
  }
});

test("extracted islands preserve the original responsive and sticky layout rules", () => {
  assert.match(providerRail, /<style scoped src="\.\/AddAgentProviderRail\.css">/);
  assert.match(actionBar, /<style scoped src="\.\/AddAgentActionBar\.css">/);
  assert.match(managedSessions, /<style scoped src="\.\/AddAgentLiveCard\.css">/);
  assert.match(providerStyles, /\.desktop-add-agent-providers\s*\{[\s\S]*?display: grid;[\s\S]*?align-content: start;/);
  assert.match(providerStyles, /@media \(max-width: 800px\)[\s\S]*?\.desktop-add-agent-providers\s*\{[\s\S]*?grid-auto-flow: column;/);
  assert.match(actionStyles, /\.desktop-add-agent-actions\s*\{[\s\S]*?bottom: -36px;[\s\S]*?margin-left: -34px;/);
  assert.match(managedSessionStyles, /\.desktop-add-agent-managed-session\s*\{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) auto;[\s\S]*?background: #13151b/);
  assert.doesNotMatch(styles, /^\.desktop-add-agent-(?:providers|managed-session|actions)\s*\{/m);
});

test("the room shell owns push-maintained sessions and a bounded repair timer", () => {
  assert.match(shell, /provide\(managedAgentSessionsKey/);
  assert.match(shell, /managedAgentSessionsRefreshTimer = window\.setTimeout/);
  assert.match(shell, /supervisorStateRepairDelayMs/);
  assert.doesNotMatch(shell, /managedAgentSessionsRefreshTimer = window\.setInterval/);
  assert.match(shell, /requestId !== managedAgentSessionsRefreshRequestId/);
  assert.match(shell, /mutationVersion === managedAgentSessionsMutationVersion/);
  assert.match(shell, /managedAgentSessionsRefreshInFlight/);
  assert.match(shell, /managedAgentSessionsRefreshQueued/);
  assert.doesNotMatch(participantSurface, /useManagedAgentSessionsContext/);
  assert.match(shell, /:managed-sessions="roomManagedAgentSessions"/);
  assert.match(shell, /@session-updated="applyAgentInspectorParticipantSessionUpdate"/);
  assert.doesNotMatch(participantSurface, /listManagedAgentSessions/);
});

test("setup owns provider, preflight, authentication, and worktree lifecycles", () => {
  assert.doesNotMatch(controller, /listAgentProviders|runAgentProviderPreflight|runAgentProviderSetup|createManagedAgentWorktree|copyTextToClipboard/);
  assert.match(setup, /listAgentProviders/);
  assert.match(setup, /runAgentProviderPreflight/);
  assert.match(setup, /runAgentProviderSetup/);
  assert.match(setup, /createManagedAgentWorktree/);
  assert.match(setup, /copyTextToClipboard/);
  assert.match(setup, /setupVersion/);
  assert.match(setup, /preflightRequestId/);
  assert.match(setup, /providerRequestId/);
  assert.match(setup, /worktreeRequestId/);
  assert.match(setup, /onBeforeUnmount\(resetTransientState\)/);
});

test("ready provider copy separates identity, state, and next action", () => {
  assert.match(presentation, /status === "ready"\) return "Choose how it works here"/);
  assert.match(presentation, /Set its model, lifecycle, and access before launch/);
  assert.match(presentation, /Set its model and access before launch/);
  assert.match(presentation, /Use the handoff below to bring it into this room/);
  assert.match(setupStatus, /\{\{ statusDescription \}\}/);
  assert.doesNotMatch(setupStatus, /preflight\?\.detail/);
});

test("external runtime guidance always retains a recovery action", () => {
  assert.match(actionBar, /v-if="installCommand"/);
  assert.match(actionBar, /v-if="installUrl"/);
  assert.match(actionBar, /v-if="!installCommand && !installUrl"/);
  assert.match(actionBar, /Check provider setup/);
  assert.match(modal, /@refresh="retryProviderSetup"/);
});
