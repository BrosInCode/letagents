import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { roomShellSource } from "./room-shell-source";

const modal = readFileSync(fileURLToPath(new URL(
  "../src/components/desktop/content/AddAgentModal.vue",
  import.meta.url,
)), "utf8");
const shell = roomShellSource();
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
const supervisedLaunch = readFileSync(fileURLToPath(new URL(
  "../src/components/desktop/content/add-agent/AddAgentSupervisedLaunch.vue",
  import.meta.url,
)), "utf8");
const controller = readFileSync(fileURLToPath(new URL(
  "../src/components/desktop/content/add-agent/useAddAgentController.ts",
  import.meta.url,
)), "utf8");
const launchComposable = readFileSync(fileURLToPath(new URL(
  "../src/components/desktop/content/add-agent/useSupervisedAgentLaunch.ts",
  import.meta.url,
)), "utf8");
const runtimeWatch = readFileSync(fileURLToPath(new URL(
  "../src/components/desktop/content/add-agent/useSupervisedRuntimeWatch.ts",
  import.meta.url,
)), "utf8");
const entriesContext = readFileSync(fileURLToPath(new URL(
  "../src/components/desktop/content/add-agent/supervisor-entries-context.ts",
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

test("Add Agent modal is not a supervisor-state polling owner", () => {
  assert.ok(modal.split("\n").length < 250, "modal shell should stay below 250 lines");
  assert.doesNotMatch(modal, /managedSessions\s*:/);
  assert.doesNotMatch(modal, /managed-sessions-updated/);
  assert.doesNotMatch(modal, /listManagedAgentSessions/);
  assert.doesNotMatch(modal, /setInterval/);
});

test("supervised launch state is consumed only by live islands", () => {
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

test("extracted islands preserve compact responsive providers and sticky actions", () => {
  assert.match(providerRail, /<style scoped src="\.\/AddAgentProviderRail\.css">/);
  assert.match(actionBar, /<style scoped src="\.\/AddAgentActionBar\.css">/);
  assert.match(supervisedLaunch, /<style scoped src="\.\/AddAgentLiveCard\.css">/);
  assert.match(providerStyles, /\.desktop-add-agent-providers\s*\{[\s\S]*?display: grid;[\s\S]*?align-content: start;/);
  assert.match(providerStyles, /@media \(max-width: 520px\)[\s\S]*?\.desktop-add-agent-providers\s*\{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(actionStyles, /\.desktop-add-agent-actions\s*\{[\s\S]*?bottom: 0;[\s\S]*?background: var\(--bg\);/);
  assert.match(managedSessionStyles, /\.desktop-add-agent-managed-session\s*\{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) auto;[\s\S]*?background: #13151b/);
  assert.doesNotMatch(styles, /^\.desktop-add-agent-(?:providers|managed-session|actions)\s*\{/m);
});

test("the room shell owns push-maintained supervisor entries and a bounded repair timer", () => {
  assert.match(shell, /provide\(supervisorEntriesKey, \{[\s\S]*?entries: shallowReadonly\(supervisorEntries\),[\s\S]*?state: readonly\(supervisorEntriesState\),[\s\S]*?error: readonly\(supervisorEntriesError\),[\s\S]*?refresh: refreshSupervisorEntries,[\s\S]*?\}\);/);
  assert.match(shell, /supervisorStateRepairDelayMs/);
  assert.doesNotMatch(shell, /RefreshTimer = window\.setInterval/);
  assert.doesNotMatch(shell, /managedAgentSessionsKey|managed-agent-sessions-context/);
  assert.doesNotMatch(shell, /@managed-session-started/);
  assert.doesNotMatch(participantSurface, /useManagedAgentSessionsContext/);
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

test("secure credential storage is a supervised readiness prerequisite", () => {
  assert.match(setup, /hasSupervisedRuntime\(bindings\.selectedProvider\.value\)[\s\S]*?supervisorGrant\.getStorageStatus\(\)/);
  assert.match(presentation, /props\.roomStorageMode === "local" \|\| secureStorageStatus\.value\?\.available === true/);
  assert.match(setupStatus, /<dt>Secure storage<\/dt>/);
  assert.match(setup, /window\.addEventListener\("focus", recheckUnlockedStorage\)/);
});

test("ready provider copy separates identity, state, and next action", () => {
  assert.match(presentation, /status === "ready"\) return "Choose how it works here"/);
  assert.match(presentation, /Choose a model, set its access, and give it something to work on/);
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

const addAgentDirectory = fileURLToPath(new URL(
  "../src/components/desktop/content/add-agent/",
  import.meta.url,
));

function countCalls(source: string, name: string): number {
  return source.match(new RegExp(`\\b${name}\\(`, "g"))?.length ?? 0;
}

test("the launch card follows the shell's pushed supervisor entries", () => {
  assert.match(entriesContext, /entries: Readonly<Ref<readonly DesktopSupervisorManifestEntry\[\]>>;/);
  assert.match(entriesContext, /state: Readonly<Ref<SupervisorEntriesResource\["state"\]>>;/);
  assert.match(entriesContext, /error: Readonly<Ref<string \| null>>;/);
  assert.match(entriesContext, /refresh: \(\) => Promise<void>;/);
  assert.match(controller, /entries: \(\) => supervisorEntries\.entries\.value,/);
  assert.match(controller, /entriesState: \(\) => supervisorEntries\.state\.value,/);
  assert.match(controller, /entriesError: \(\) => supervisorEntries\.error\.value,/);
  assert.match(launchComposable, /entries: \(\) => readonly DesktopSupervisorManifestEntry\[\];/);
  assert.match(launchComposable, /entriesState: \(\) => SupervisorEntriesResource\["state"\];/);
  assert.match(launchComposable, /entriesError: \(\) => string \| null;/);
  assert.match(launchComposable, /useSupervisedRuntimeWatch\(\{[\s\S]*?entries: options\.entries,[\s\S]*?entriesState: options\.entriesState,[\s\S]*?entriesError: options\.entriesError,/);
  assert.match(runtimeWatch, /const handle = watch\(\s*\(\) => \[\s*options\.entries\(\)\.find\(\(candidate\) => candidate\.id === entryId\) \?\? null,\s*options\.entriesState\(\),\s*\] as const,/);
  assert.match(runtimeWatch, /\{ immediate: true \}/);
  assert.match(runtimeWatch, /reportReadError\(null, options\.entriesError\(\) \?\? SUPERVISED_RUNTIME_READ_ERROR\);/);
  // A disagreeing desired state is ignored only while the shell still holds the
  // list from watch start; any later push is a new array and is applied.
  assert.match(runtimeWatch, /const listAtStart = options\.entries\(\);/);
  assert.match(runtimeWatch, /options\.entries\(\) === listAtStart && held && held\.id === entry\.id\s*&& held\.desiredState !== entry\.desiredState\) return;/);
});

test("the add-agent flow has no daemon read loop or polling timer", () => {
  assert.equal(
    existsSync(new URL("../src/components/desktop/content/add-agent/useSupervisedRuntimePolling.ts", import.meta.url)),
    false,
    "the polling composable is retired",
  );
  for (const [name, source] of [["useSupervisedRuntimeWatch.ts", runtimeWatch], ["useSupervisedAgentLaunch.ts", launchComposable]]) {
    assert.doesNotMatch(source, /RuntimePolling|startPolling|stopPolling/, `${name} names no polling composable`);
    assert.doesNotMatch(source, /\b(?:setTimeout|setInterval|clearTimeout|clearInterval|requestAnimationFrame)\b/, `${name} schedules no timers`);
  }
  assert.doesNotMatch(runtimeWatch, /\b(?:while|for|do)\s*[({]/, "the watch has no loop construct");

  // Every direct supervisor read in the flow, by file. A new entry here is a
  // new read site and needs the same scrutiny as the three below.
  const readSites: Record<string, { listAgents: number; refreshSupervisedRuntimeEntry: number }> = {};
  const files = [
    ...readdirSync(addAgentDirectory)
      .filter((name) => name.endsWith(".ts") || name.endsWith(".vue"))
      .map((name) => [name, readFileSync(`${addAgentDirectory}${name}`, "utf8")] as const),
    ["AddAgentModal.vue", modal] as const,
  ];
  for (const [name, source] of files) {
    const counts = {
      listAgents: countCalls(source, "listAgents"),
      refreshSupervisedRuntimeEntry: countCalls(source, "refreshSupervisedRuntimeEntry"),
    };
    if (counts.listAgents || counts.refreshSupervisedRuntimeEntry) readSites[name] = counts;
  }
  assert.deepEqual(readSites, {
    // The recovery scan, the explicit recovery revalidation and the ambiguous-create lookup.
    "useSupervisedLaunchRecovery.ts": { listAgents: 1, refreshSupervisedRuntimeEntry: 2 },
    // recoverFailedCreation.
    "useSupervisedAgentLaunch.ts": { listAgents: 0, refreshSupervisedRuntimeEntry: 1 },
    // The single confirming read, and the revalidation after a rejected stop.
    "useSupervisedRuntimeWatch.ts": { listAgents: 0, refreshSupervisedRuntimeEntry: 2 },
  });

  const recoverFailedCreationBody = launchComposable.slice(
    launchComposable.indexOf("async function recoverFailedCreation"),
    launchComposable.indexOf("function activateRecoveredEntry"),
  );
  assert.equal(countCalls(recoverFailedCreationBody, "refreshSupervisedRuntimeEntry"), 1);

  // The confirming read runs once per missing-entry report, only when the
  // shell finished reading, and never while another confirming read runs.
  const confirmBody = runtimeWatch.slice(
    runtimeWatch.indexOf("const confirmMissing"),
    runtimeWatch.indexOf("const handle = watch("),
  );
  assert.equal(countCalls(confirmBody, "refreshSupervisedRuntimeEntry"), 1);
  assert.match(confirmBody, /if \(confirming\) return;\s*confirming = true;/);
  // A push that arrived during the read wins over the read result.
  assert.match(confirmBody, /if \(options\.entries\(\)\.some\(\(candidate\) => candidate\.id === entryId\)\) return;/);
  assert.match(runtimeWatch, /if \(state === "ready"\) void confirmMissing\(\);/);
  assert.equal(countCalls(runtimeWatch, "confirmMissing"), 1, "the confirming read has one caller");
  const stopEntryBody = runtimeWatch.slice(runtimeWatch.indexOf("async function stopEntry"));
  assert.equal(countCalls(stopEntryBody, "refreshSupervisedRuntimeEntry"), 1);
});
