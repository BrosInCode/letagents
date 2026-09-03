import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const modalSource = readFileSync(fileURLToPath(new URL(
  "../src/components/desktop/content/AddAgentModal.vue",
  import.meta.url,
)), "utf8");

const progressSource = readFileSync(fileURLToPath(new URL(
  "../src/components/desktop/content/SupervisedLaunchProgress.vue",
  import.meta.url,
)), "utf8");
const launchSource = readFileSync(fileURLToPath(new URL(
  "../src/components/desktop/content/add-agent/useSupervisedAgentLaunch.ts",
  import.meta.url,
)), "utf8");
const launchEventStreamSource = readFileSync(fileURLToPath(new URL(
  "../src/components/desktop/content/add-agent/useSupervisedLaunchEventStream.ts",
  import.meta.url,
)), "utf8");
const launchRecoverySource = readFileSync(fileURLToPath(new URL(
  "../src/components/desktop/content/add-agent/useSupervisedLaunchRecovery.ts",
  import.meta.url,
)), "utf8");
const launchComponentSource = readFileSync(fileURLToPath(new URL(
  "../src/components/desktop/content/add-agent/AddAgentSupervisedLaunch.vue",
  import.meta.url,
)), "utf8");
const launchActionsSource = readFileSync(fileURLToPath(new URL(
  "../src/components/desktop/content/add-agent/AddAgentSupervisedLaunchActions.ts",
  import.meta.url,
)), "utf8");
const launchActionStyles = readFileSync(fileURLToPath(new URL(
  "../src/components/desktop/content/add-agent/AddAgentSupervisedLaunchActions.module.css",
  import.meta.url,
)), "utf8");
const actionBarSource = readFileSync(fileURLToPath(new URL(
  "../src/components/desktop/content/add-agent/AddAgentActionBar.vue",
  import.meta.url,
)), "utf8");
const controllerSource = readFileSync(fileURLToPath(new URL(
  "../src/components/desktop/content/add-agent/useAddAgentController.ts",
  import.meta.url,
)), "utf8");
const configurationSource = readFileSync(fileURLToPath(new URL(
  "../src/components/desktop/content/add-agent/useAddAgentConfiguration.ts",
  import.meta.url,
)), "utf8");
const runtimeSettingsSource = readFileSync(fileURLToPath(new URL(
  "../src/components/desktop/content/add-agent/AddAgentRuntimeSettings.vue",
  import.meta.url,
)), "utf8");
const presentationSource = readFileSync(fileURLToPath(new URL(
  "../src/components/desktop/content/add-agent/useAddAgentPresentation.ts",
  import.meta.url,
)), "utf8");
const setupSource = readFileSync(fileURLToPath(new URL(
  "../src/components/desktop/content/add-agent/useAddAgentSetup.ts",
  import.meta.url,
)), "utf8");
const recoveryNoticeSource = readFileSync(fileURLToPath(new URL(
  "../src/components/desktop/content/add-agent/AddAgentRecoveryNotice.vue",
  import.meta.url,
)), "utf8");
const progressStyles = readFileSync(fileURLToPath(new URL(
  "../src/components/desktop/content/SupervisedLaunchProgress.css",
  import.meta.url,
)), "utf8");
const feedbackSource = readFileSync(fileURLToPath(new URL(
  "../src/components/desktop/content/add-agent/AddAgentFeedback.vue",
  import.meta.url,
)), "utf8");
const errorSource = readFileSync(fileURLToPath(new URL(
  "../src/components/desktop/content/add-agent/add-agent-errors.ts",
  import.meta.url,
)), "utf8");
const safeErrorSource = readFileSync(fileURLToPath(new URL(
  "../src/domain/user-visible-error.ts",
  import.meta.url,
)), "utf8");

test("Add Agent modal renders the phased launch row from real supervisor state", () => {
  assert.match(launchComponentSource, /import SupervisedLaunchProgress from "\.\.\/SupervisedLaunchProgress\.vue"/);
  assert.match(launchSource, /import \{ supervisedLaunchProgress \}/);
  assert.match(launchSource, /import \{ foldLaunchJourney \}/);
  assert.match(launchComponentSource, /<SupervisedLaunchProgress[\s\S]*?:progress="progress"[\s\S]*?:recovering="controller\.launch\.recoveryPending\.value"[\s\S]*?@recover="controller\.launch\.handleRecover\(\$event\)"/);
  assert.match(launchSource, /const view = computed\(/);
  assert.match(launchSource, /foldLaunchJourney\(\{/);
});

test("Add Agent modal shows the launch card the instant Start is clicked, backed by the event stream", () => {
  // The card must appear before createAgent resolves: launchStarted is set and
  // the launch-event subscription attaches before the awaited create call.
  const startBody = controllerSource.slice(controllerSource.indexOf("const creationRequestId = supervisedLaunch.begin();"));
  assert.match(launchSource, /launchStarted\.value = true;/);
  assert.match(startBody, /supervisedLaunch\.begin\(\)[\s\S]*await createSupervisedAgentFromSnapshot\(/);
  assert.match(controllerSource, /createSupervisedAgentFromSnapshot\([\s\S]*?desktopIpc\.supervisor,[\s\S]*?creationSnapshot/);
  assert.match(launchEventStreamSource, /desktopIpc\.supervisor\.onLaunchEvent/);
  assert.match(launchEventStreamSource, /desktopIpc\.supervisor\.getLaunchEvents/);
});

test("Add Agent modal folds launch events idempotently by sequence", () => {
  assert.match(launchEventStreamSource, /existing\.sequence === event\.sequence/);
});

test("the sign-in recovery performs a real provider-auth action and does not start the agent", () => {
  // sign_in (with a command) must copy the provider sign-in command and RETURN,
  // never falling through to startManagedAgent.
  assert.match(launchSource, /action === "sign_in" && command/);
  const signInBranch = launchSource.slice(launchSource.indexOf('action === "sign_in"'));
  assert.match(signInBranch, /options\.onCopyAuthCommand\(command\)[\s\S]*?return;/);
  // The retry/reconnect fallthrough (and command-absent sign_in) is the only
  // path that starts the agent.
  const recoverBody = launchSource.slice(launchSource.indexOf("function handleRecover"));
  assert.match(recoverBody, /creationRequestId\.value = activeLaunchId\.value;[\s\S]*?options\.onRetry\(\)/);
});

test("Keychain recovery opens the native credential manager without weakening storage", () => {
  const recoverBody = launchSource.slice(launchSource.indexOf("async function handleRecover"));
  assert.match(recoverBody, /action === "open_keychain"/);
  assert.match(recoverBody, /desktopIpc\.app\.openCredentialStorage\(\)/);
  assert.match(recoverBody, /unlock the login keychain/i);
  assert.match(progressSource, /Open Keychain Access/);
  assert.match(progressSource, /supervised-launch-keychain-retry/);
});

test("a concurrent successful storage recheck cannot be overwritten by stale recovery guidance", () => {
  assert.match(
    controllerSource,
    /await desktopIpc\.app\.openCredentialStorage\(\);[\s\S]*?if \(secureStorageStatus\.value\?\.available !== true\) \{[\s\S]*?setSecureStorageRecoveryMessage/,
  );
});

test("Try again converges a durable launch entry instead of creating a second agent", () => {
  assert.match(controllerSource, /onRetry: \(\) => retrySupervisedLaunch\(\)/);
  const retryBody = controllerSource.slice(
    controllerSource.indexOf("async function retrySupervisedLaunch"),
    controllerSource.indexOf("async function startManagedAgent"),
  );
  assert.match(retryBody, /const entry = supervisedLaunch\.conflict\.value/);
  assert.match(retryBody, /if \(!entry\) \{[\s\S]*?view\.value\?\.failed[\s\S]*?await startManagedAgent\(\{ retryingPreDurableLaunch: true \}\)/);
  assert.match(retryBody, /supervisor\.setDesiredState\(entry\.id, "running"\)/);
  assert.match(retryBody, /supervisedLaunch\.complete\(updated\)/);
  assert.match(retryBody, /managedSessionsContext\.refresh\(\)/);
  assert.match(controllerSource, /const retryingSamePreDurableLaunch = \([\s\S]*?supervisedLaunchView\.value\.durable === false[\s\S]*?!supervisedConflict\.value/);
  assert.match(controllerSource, /hasActiveLaunch: Boolean\([\s\S]*?supervisedConflict\.value[\s\S]*?!retryingSamePreDurableLaunch/);
});

test("Add Agent modal safely contextualizes supervised lookup errors outside the product card", () => {
  // The card stays event-backed; the adjacent feedback owns a scrubbed,
  // contextual daemon error and an explicit retry.
  assert.doesNotMatch(modalSource, /\{\{\s*supervisedConflictLookupError\s*\}\}/);
  assert.match(launchComponentSource, /:message="lookupError"/);
  assert.match(launchComponentSource, /:action-label="recoveryScanStatus === 'error' \? 'Check again' : null"/);
  assert.match(launchSource, /contextualAddAgentError/);
  assert.match(errorSource, /safeUserVisibleErrorDetail/);
  assert.match(safeErrorSource, /AUTHORIZATION_HEADER/);
  assert.match(safeErrorSource, /\[redacted\]/);
});

test("Add Agent modal requires first recovery consent and restores previously attached launches", () => {
  assert.match(controllerSource, /detectRecoverableSupervisedLaunch/);
  assert.match(launchRecoverySource, /supervisor\.listAgents\(roomIdentifier\)/);
  const detectionBody = launchRecoverySource.slice(
    launchRecoverySource.indexOf("async function detect"),
    launchRecoverySource.indexOf("async function recover"),
  );
  assert.match(detectionBody, /recoverable\.find\(\(entry\) => options\.hasRememberedLaunch\(roomIdentifier, entry\.id\)\)/);
  assert.match(detectionBody, /options\.activate\(launching\)/);
  assert.doesNotMatch(detectionBody, /startRuntimeRefresh\(/);
  const recoveryBody = launchRecoverySource.slice(
    launchRecoverySource.indexOf("async function recover"),
    launchRecoverySource.indexOf("function offer"),
  );
  assert.match(recoveryBody, /supervisor\.resumeOwnershipTransfer\(entry\.id\)/);
  assert.doesNotMatch(recoveryBody, /supervisor\.setDesiredState\(entry\.id,\s*"running"\)/);
  assert.match(recoveryBody, /options\.rememberLaunch\(roomIdentifier, entry\.id\)/);
  assert.match(recoveryBody, /options\.activate\(entry\)/);
  const activationBody = launchSource.slice(
    launchSource.indexOf("function activateRecoveredEntry"),
    launchSource.indexOf("async function recoverDetectedLaunch"),
  );
  assert.match(activationBody, /subscribe\(/);
  assert.match(activationBody, /complete\(entry\)/);
  assert.match(launchComponentSource, /<AddAgentRecoveryNotice/);
  assert.match(modalSource, /@recover-launch="handleRecoverSupervisedLaunch"/);
  assert.match(actionBarSource, /props\.canStartBase[\s\S]*?canStartNewSupervisedLaunch\(\{/);
  assert.match(controllerSource, /canStartNewSupervisedLaunch\(\{[\s\S]*?hasRecoveryCandidate: Boolean\(supervisedRecoveryCandidate\.value\)/);
  assert.match(controllerSource, /supervisedLaunch\.offerRecoveryCandidate\(entry\)/);
  assert.match(controllerSource, /supervisedLaunch\.offerAmbiguousCreationCandidate\(/);
  assert.match(controllerSource, /candidate\.provider !== selectedProviderId\.value/);
  assert.match(controllerSource, /watch\(\[supervisedRecoveryCandidate, supervisedConflict, selectedProvider\]/);
  assert.match(controllerSource, /provider\?\.id === recoveryEntry\.provider[\s\S]*?launchMode\.value = "supervised"/);
});

test("failed recovery scans allow a new launch without hiding real setup blockers", () => {
  assert.match(actionBarSource, /recoveryScanStatus\.value === "error"[\s\S]*?"Start new supervised agent"/);
  assert.ok(
    actionBarSource.indexOf('v-else-if="launchMode === \'supervised\' && charterMissing"')
      < actionBarSource.indexOf('recoveryScanStatus !== \'ready\''),
    "charter guidance must precede the non-blocking recovery error copy",
  );
  assert.doesNotMatch(actionBarSource, /permissionBlocker/);
  assert.doesNotMatch(modalSource, /supervisedPermissionBridgeUnavailable/);
});

test("an active supervised launch owns the action bar instead of stale preflight actions", () => {
  assert.match(actionBarSource, /v-if="!activeSupervisedLaunch" class="desktop-add-agent-action-buttons"/);
  assert.match(actionBarSource, /activeSupervisedLaunch\.ready[\s\S]*?is active in this room/);
  assert.match(actionBarSource, /activeSupervisedLaunch = computed\(\(\) => props\.supervised\.launch\.view\.value\)/);
  assert.doesNotMatch(actionBarSource, /if \(props\.launchMode !== "supervised"\) return null/);
  assert.doesNotMatch(actionBarSource, /progress && !progress\.failed && !progress\.stopped/);
  assert.match(actionBarSource, /activeSupervisedLaunch\.agentName \|\| activeSupervisedLaunch\.providerLabel/);
  assert.match(actionBarSource, /activeSupervisedLaunch\.status === "stopping"[\s\S]*?is stopping/);
  assert.match(actionBarSource, /providerLabel\} setup is in progress/);
});

test("a ready supervised launch can start another without stopping the completed agent", () => {
  assert.match(launchActionsSource, /"data-testid": "desktop-add-agent-add-another-supervised"/);
  assert.match(launchActionsSource, /`Add another \$\{props\.providerName\} agent`/);
  assert.match(launchComponentSource, /props\.controller\.launch\.canAddAnotherSupervisedAgent\.value/);
  assert.match(launchComponentSource, /@add-another="controller\.launch\.dismissReadyLaunchForAnother"/);
  assert.match(launchSource, /function dismissReadyLaunchForAnother\(\): void/);
  const releaseBody = launchSource.slice(
    launchSource.indexOf("function dismissReadyLaunchForAnother"),
    launchSource.indexOf("function resetActiveLaunch"),
  );
  assert.match(releaseBody, /dismiss\(\);/);
  assert.doesNotMatch(releaseBody, /stop\(/);
  assert.match(controllerSource, /suggestSupervisedAgentCodename\([\s\S]*?existingDisplayNames,[\s\S]*?snapshot\.creationRequestId/);
  assert.match(controllerSource, /providerId: snapshot\.providerId,[\s\S]*?displayName,/);
});

test("bounded supervised defaults never tell providers to own polling and Claude exposes no ignored effort control", () => {
  assert.doesNotMatch(configurationSource, /keep polling until stopped/);
  assert.match(presentationSource, /return "Managed at launch"/);
  assert.match(
    configurationSource,
    /Join the room, check the board, and help move the available work forward/,
  );
  assert.match(presentationSource, /showEffortSelector = computed\(\(\) =>\s*selectedProviderId\.value === "codex"\s*\)/);
  assert.doesNotMatch(presentationSource, /showEffortSelector[\s\S]{0,160}claude-code/);
});

test("supervised creation presents the startup text as a one-time initial message", () => {
  assert.match(runtimeSettingsSource, /<small>Initial message<\/small>/);
  assert.match(runtimeSettingsSource, /It is sent once/);
  assert.doesNotMatch(runtimeSettingsSource, /<small>Charter<\/small>/);
  assert.match(actionBarSource, /Add an initial message before starting/);
});

test("supervised providers expose their supervised permission presentation instead of forcing read-only", () => {
  assert.match(presentationSource, /const profiles = selectedProvider\.value\?\.permissionProfiles \?\? \[\]/);
  assert.match(presentationSource, /profiles\.map\(\(profile\) => supervisedPermissionProfilePresentation\(selectedProviderId\.value, profile\)\)/);
  assert.match(configurationSource, /const permissionProfiles = bindings\.selectedPermissionProfiles\.value/);
  assert.match(controllerSource, /selectedPermissionProfiles,[\s\S]*?selectedPermissionProfile,/);
  assert.doesNotMatch(presentationSource, /profiles\.filter\(\(profile\) => profile\.id === "read_only"\)/);
  assert.match(presentationSource, /private turn workspace/);
  assert.match(presentationSource, /Git history and ignored output are not persisted/);
  assert.match(presentationSource, /Daemon-mediated LetAgents room tools remain available/);
});

test("the supervised action island owns complete responsive interaction styles", () => {
  assert.match(launchActionsSource, /import styles from "\.\/AddAgentSupervisedLaunchActions\.module\.css"/);
  assert.match(launchActionsSource, /class: \[styles\.button, styles\.danger\]/);
  assert.match(launchActionStyles, /\.button\s*\{[\s\S]*?min-height: 34px/);
  assert.match(launchActionStyles, /\.button:hover:not\(:disabled\)/);
  assert.match(launchActionStyles, /\.button:disabled/);
  assert.match(launchActionStyles, /prefers-reduced-motion: reduce/);
  assert.match(launchActionStyles, /@media \(max-width: 680px\)[\s\S]*?\.actions/);
});

test("legacy start feedback is assigned only after the modal request guard", () => {
  assert.match(controllerSource, /const startMessage = await managedLaunch\.start\([\s\S]*?if \(!setupActions\.isCurrentRequest\(requestVersion\)\) return;[\s\S]*?setSetupMessage\(startMessage\);/);
  assert.match(controllerSource, /const requestLaunchMode = launchMode\.value;/);
  assert.match(setupSource, /onBeforeUnmount\(resetTransientState\)/);
});

test("supervised start rechecks secure storage before creating a launch", () => {
  const storageCheck = controllerSource.indexOf("await desktopIpc.supervisorGrant.getStorageStatus()");
  const launchBoundary = controllerSource.indexOf("supervisedLaunch.begin()", storageCheck);
  assert.ok(storageCheck >= 0, "supervised Start should perform a secure-storage round-trip");
  assert.ok(launchBoundary > storageCheck, "secure storage must be checked before the launch boundary");
  assert.match(controllerSource, /if \(!latestStorageStatus\.available\) \{[\s\S]*?return;/);
});

test("an in-flight Start remains fenced across modal close and provider reset", () => {
  assert.match(controllerSource, /let startOperationInFlight = false/);
  // A repo-less room (no git binding, no resolved repo path) is allowed to
  // launch — the daemon provisions a private scratch workspace — but a
  // repo-backed room with an unresolved path is still fenced.
  assert.match(controllerSource, /const roomOnlyLaunch = props\.roomGitRoom == null && !props\.repoRootPath\?\.trim\(\)/);
  assert.match(controllerSource, /if \(!selectedProviderId\.value \|\| \(!props\.repoRootPath\?\.trim\(\) && !roomOnlyLaunch\) \|\| startOperationInFlight\) return/);
  assert.match(controllerSource, /onResetStartingAgent: \(\) => \{ startingAgent\.value = startOperationInFlight; \}/);
  assert.match(controllerSource, /finally \{[\s\S]*?startOperationInFlight = false;[\s\S]*?startingAgent\.value = false;/);
});

test("Add Agent modal no longer shows the opaque observed-state/condition line", () => {
  assert.doesNotMatch(modalSource, /observedState \}\} · \{\{ supervisedConflict\.condition/);
});

test("the launch progress component exposes phased, accessible, honest UI hooks", () => {
  for (const phaseId of [
    "preparing_workspace",
    "starting_provider",
    "connecting_room",
    "registering_identity",
    "ready",
  ]) {
    assert.match(progressSource, new RegExp(`supervised-launch-phase-\\$\\{phase.id\\}`));
    assert.ok(phaseId);
  }
  assert.match(progressSource, /data-testid="supervised-launch-progress"/);
  assert.match(progressSource, /data-testid="supervised-launch-join-hint"/);
  assert.match(progressSource, /data-testid="supervised-launch-failure"/);
  assert.match(progressSource, /data-testid="supervised-launch-failure-impact"/);
  assert.match(progressSource, /v-for="phase in visiblePhases"/);
  assert.match(progressSource, /progress\.failureDiagnostic/);
  assert.match(progressSource, /recovering \? recoveryPendingLabel/);
  assert.match(progressSource, /"open_keychain" \? "Opening…" : "Trying again…"/);
  assert.match(progressSource, /progress\.durable/);
  assert.match(progressSource, /data-testid="supervised-launch-ready-name"/);
  assert.doesNotMatch(recoveryNoticeSource, /aria-live=/);
  assert.match(launchComponentSource, /class="sr-only" aria-live="polite" aria-atomic="true"/);
  assert.match(launchComponentSource, /desktop-add-agent-supervised-lookup-error"[\s\S]*?tabindex="-1"/);
  assert.match(feedbackSource, /:role="tone === 'error' \? 'alert' : 'status'"/);
  assert.match(feedbackSource, /:aria-live="tone === 'error' \? 'assertive' : 'polite'"/);
  assert.match(modalSource, /querySelector<HTMLElement>[\s\S]*?desktop-add-agent-supervised-runtime[\s\S]*?\.focus\(\)/);
  assert.match(progressSource, /if \(p\.failed\) return "";/);
  assert.match(progressSource, /if \(p\.status === "stopping"\) return p\.headline;[\s\S]*?if \(p\.failed\) return "";/);
  assert.match(progressSource, /case "stopping": return "Cancelling";/);
  assert.match(modalSource, /<AddAgentFeedback v-if="setupMessage" :message="setupMessage" :tone="setupMessageTone"/);
  assert.match(launchComponentSource, /if \(progress\.value\.ready\) return "ready";/);
  assert.match(launchComponentSource, /if \(progress\.value\.stopped\) return "stopped";/);
  assert.match(progressStyles, /@media \(max-width: 680px\)[\s\S]*?white-space: normal/);
});
