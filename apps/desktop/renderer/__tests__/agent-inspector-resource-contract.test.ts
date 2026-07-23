import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

const shell = source("../src/components/desktop/content/DesktopRoomShell.vue");
const modal = source("../src/components/desktop/content/DesktopAgentDetailModal.vue");
const activity = source("../src/components/desktop/content/RoomActivityTabView.vue");
const launcher = source("../src/components/desktop/content/room-chat/useAgentReasoningLauncher.ts");

test("the room shell is the single supervisor list owner and retains load state", () => {
  assert.match(shell, /supervisorEntriesState = ref<SupervisorEntriesResource\["state"\]>/);
  assert.match(shell, /supervisorEntriesHaveLoaded\.value \? "refreshing" : "loading"/);
  assert.match(shell, /Keep the last successfully loaded entries/);
  assert.match(shell, /selectedAgentDetailRequest = ref<AgentInspectorRequest \| null>/);
  assert.match(shell, /selectedAgentDetailTarget = computed<AgentInspectorSelection \| null>/);
  assert.match(shell, /resolveAgentInspectorSelection\(/);
  assert.match(shell, /participantAgentInspectorRequest\(target\)/);
});

test("supervisor action updates fence stale poll results", () => {
  assert.match(shell, /const supervisorMutationVersion = supervisorEntriesMutationVersion/);
  assert.match(shell, /if \(supervisorMutationVersion === supervisorEntriesMutationVersion\)/);
  const upsert = shell.slice(
    shell.indexOf("function upsertSupervisorEntry"),
    shell.indexOf("async function resolveComposerPermission"),
  );
  assert.match(upsert, /supervisorEntriesMutationVersion \+= 1/);
});

test("room changes close the inspector instead of carrying its request across rooms", () => {
  const roomWatch = shell.slice(
    shell.indexOf("watch(() => props.room.identifier"),
    shell.indexOf("watch(() => props.repoStatus"),
  );
  assert.match(roomWatch, /selectedAgentDetailRequest\.value = null/);
});

test("the modal consumes shared supervisor data and owns no supervisor poll", () => {
  assert.match(modal, /supervisorResource: SupervisorEntriesResource/);
  assert.match(modal, /const supervisorEntries = computed\(\(\) => props\.supervisorResource\.data\)/);
  assert.doesNotMatch(modal, /desktopIpc\.supervisor\.listAgents/);
  assert.doesNotMatch(modal, /desktopIpc\.supervisor\.getStatus/);
  assert.doesNotMatch(modal, /setInterval\(/);
  assert.match(modal, /target\.kind === 'external' && showExternalFallback/);
  assert.match(modal, /desktop-agent-detail-supervisor-unavailable/);
});

test("truthful Activity opens the exact durable entry", () => {
  assert.match(activity, /supervisedAgentInspectorRequest\(selectedTruthfulAgent/);
  assert.match(activity, /data-testid="desktop-activity-open-supervised-agent-controls"/);
});

test("opening the Inspector bypasses actor-label presence enrichment", () => {
  const detailBranch = launcher.slice(
    launcher.indexOf("if (options.openAgentDetail)"),
    launcher.indexOf("const resolvedTarget = agentTargetWithPresenceSession"),
  );
  assert.match(detailBranch, /options\.openAgentDetail\(target\)/);
  assert.doesNotMatch(detailBranch, /agentTargetWithPresenceSession/);
});
