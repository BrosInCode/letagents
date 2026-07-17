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

test("Add Agent modal renders the phased launch row from real supervisor state", () => {
  assert.match(modalSource, /import SupervisedLaunchProgress from "\.\/SupervisedLaunchProgress\.vue"/);
  assert.match(modalSource, /import \{ supervisedLaunchProgress \} from "\.\.\/\.\.\/\.\.\/domain\/supervised-launch"/);
  assert.match(modalSource, /<SupervisedLaunchProgress :progress="supervisedLaunchView" \/>/);
  assert.match(modalSource, /const supervisedLaunchView = computed\(/);
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
