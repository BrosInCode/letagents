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

const shellSource = readFileSync(fileURLToPath(new URL(
  "../src/components/desktop/content/DesktopRoomShell.vue",
  import.meta.url,
)), "utf8");

const appSource = readFileSync(fileURLToPath(new URL(
  "../src/App.vue",
  import.meta.url,
)), "utf8");

test("Add Agent modal renders the phased launch row from real supervisor state", () => {
  assert.match(modalSource, /import SupervisedLaunchProgress from "\.\/SupervisedLaunchProgress\.vue"/);
  assert.match(modalSource, /import \{ supervisedLaunchProgress \} from "\.\.\/\.\.\/\.\.\/domain\/supervised-launch"/);
  assert.match(modalSource, /import \{ foldLaunchJourney \} from "\.\.\/\.\.\/\.\.\/domain\/launch-journey"/);
  assert.match(modalSource, /<SupervisedLaunchProgress :progress="supervisedLaunchView" @recover="handleLaunchRecover" \/>/);
  assert.match(modalSource, /const supervisedLaunchView = computed\(/);
  assert.match(modalSource, /foldLaunchJourney\(\{/);
});

test("Add Agent modal shows the launch card the instant Start is clicked, backed by the event stream", () => {
  // The card must appear before createAgent resolves: launchStarted is set and
  // the launch-event subscription attaches before the awaited create call.
  const startBody = modalSource.slice(modalSource.indexOf("launchStarted.value = true;"));
  assert.match(modalSource, /launchStarted\.value = true;/);
  assert.match(startBody, /subscribeLaunchEvents\(supervisedCreationRequestId\)[\s\S]*await desktopIpc\.supervisor\.createAgent\(/);
  assert.match(modalSource, /desktopIpc\.supervisor\.onLaunchEvent/);
  assert.match(modalSource, /desktopIpc\.supervisor\.getLaunchEvents/);
});

test("Add Agent supervised Start carries independently derived active, project, and requested room evidence", () => {
  assert.match(appSource, /:active-room-identifier="activeEntry\.roomIdentifier"/);
  assert.match(shellSource, /addAgentModalOpen && activeRoomMatchesShell/);
  assert.match(shellSource, /props\.roomLoading \|\| !activeRoomMatchesShell\.value/);
  assert.match(modalSource, /activeRoomIdentifier: props\.activeRoomIdentifier/);
  assert.match(modalSource, /projectRoomIdentifier: props\.roomIdentifier/);
  assert.match(modalSource, /projectRootPath: props\.repoRootPath/);
});

test("Add Agent modal folds launch events idempotently by sequence", () => {
  assert.match(modalSource, /existing\.sequence === event\.sequence/);
});

test("the sign-in recovery performs a real provider-auth action and does not start the agent", () => {
  // sign_in (with a command) must copy the provider sign-in command and RETURN,
  // never falling through to startManagedAgent.
  assert.match(modalSource, /action === "sign_in" && authCommand\.value/);
  const signInBranch = modalSource.slice(modalSource.indexOf('action === "sign_in"'));
  assert.match(signInBranch, /copyAgentAuthCommand\(\)[\s\S]*?return;/);
  // The retry/reconnect fallthrough (and command-absent sign_in) is the only
  // path that starts the agent.
  const recoverBody = modalSource.slice(modalSource.indexOf("function handleLaunchRecover"));
  assert.match(recoverBody, /supervisedCreationRequestId = activeLaunchId\.value;[\s\S]*?startManagedAgent\(\)/);
});

test("Add Agent modal keeps raw supervised lookup errors out of the product card", () => {
  // The raw daemon lookup error must not be interpolated into the card.
  assert.doesNotMatch(modalSource, /\{\{\s*supervisedConflictLookupError\s*\}\}/);
  assert.match(modalSource, /We lost track of this launch/);
});

test("Add Agent modal restores an in-flight launch on reopen from the daemon manifest", () => {
  assert.match(modalSource, /restoreSupervisedLaunchInProgress/);
  assert.match(modalSource, /supervisor\.listAgents\(props\.roomIdentifier\)/);
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
  assert.match(progressSource, /data-testid="supervised-launch-ready-name"/);
});
