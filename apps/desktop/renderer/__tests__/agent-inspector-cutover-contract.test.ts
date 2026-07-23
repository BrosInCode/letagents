import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

const shell = source("../src/components/desktop/content/DesktopRoomShell.vue");
const activity = source("../src/components/desktop/content/RoomActivityTabView.vue");
const host = source("../src/components/desktop/content/agent-inspector/AgentInspectorHost.vue");
const participantSurface = source("../src/components/desktop/content/agent-inspector/AgentInspectorParticipantSurface.vue");
const identity = source("../src/domain/agent-inspector-identity.ts");
const styles = source("../src/components/desktop/content/agent-inspector/agent-inspector.css");

test("one agent inspector owns every selected detail surface", () => {
  assert.match(shell, /<AgentInspectorHost\s*[\s\S]*v-if="selectedAgentDetailTarget"/);
  assert.doesNotMatch(shell, /agentInspectorFoundationEnabled|DesktopAgentDetailModal|projectAgentInspectorsWhenEnabled/);
  assert.doesNotMatch(activity, /agentInspectorFoundationEnabled|legacyTruthful|desktop-room-agent-(?:reconnect|recover)/);
  assert.equal(existsSync(fileURLToPath(new URL("../src/components/desktop/content/DesktopAgentDetailModal.vue", import.meta.url))), false);
  assert.equal(existsSync(fileURLToPath(new URL("../src/domain/agent-inspector-feature.ts", import.meta.url))), false);
});

test("Activity opens the exact shared Inspector for supervised and generic participants", () => {
  assert.match(activity, /@click="selectInspectorAgent\(agent\)"/);
  assert.match(activity, /supervisedAgentInspectorRequest\(agent\.entry/);
  assert.match(activity, /@click="selectParticipantAgent\(agent\)"/);
  assert.match(activity, /participantAgentInspectorRequest\(activityParticipantToAgentTarget\(agent\)\)/);
  assert.match(activity, /useRoomActivityViewModel\(props, \{ autoSelectLive: false \}\)/);
  assert.match(shell, /:agent-projections="agentInspectorProjections"/);
});

test("the shared Inspector keeps external and exact local-managed participants distinct", () => {
  assert.match(host, /projectAgentInspectorParticipant\(props\.selection, props\.managedSessions\)/);
  assert.match(host, /selection\.kind === "external"/);
  assert.match(participantSurface, /projection\.kind === 'local_managed'/);
  assert.match(participantSurface, /participant-inspector-stop-turn/);
  assert.match(participantSurface, /participant-inspector-retry/);
  assert.match(participantSurface, /participant-inspector-stop-worker/);
  assert.match(identity, /Only a completed list operation can authoritatively classify the target[\s\S]*resource\.state === "ready"/);
  assert.match(identity, /resource\.state === "error"[\s\S]*unavailableReason: "load_error"/);
  assert.doesNotMatch(identity, /displayName.*resolveSupervisorEntryId|sender.*resolveSupervisorEntryId/);
});

test("the single Inspector retains its responsive and accessible sheet behavior", () => {
  assert.match(host, /<Teleport v-if="compact" to="body">/);
  assert.match(host, /setShellContentInert/);
  assert.match(host, /restoreFocusElement = document\.activeElement/);
  assert.match(styles, /prefers-reduced-motion/);
  assert.match(styles, /prefers-reduced-transparency/);
  assert.match(styles, /prefers-contrast/);
  assert.doesNotMatch(styles, /transition:\s*all|ease-in/);
});
