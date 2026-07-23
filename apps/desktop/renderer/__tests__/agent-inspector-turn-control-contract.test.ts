import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

const shell = source("../src/components/desktop/content/DesktopRoomShell.vue");
const surface = source("../src/components/desktop/content/agent-inspector/AgentInspectorSurface.vue");
const control = source("../src/components/desktop/content/agent-inspector/AgentInspectorTurnControl.vue");
const lifecycle = source("../src/components/desktop/content/agent-inspector/AgentInspectorLifecycleActions.vue");
const styles = source("../src/components/desktop/content/agent-inspector/agent-inspector.css");

test("the Inspector routes a correction and uncertain resolution through durable supervisor controls", () => {
  assert.match(surface, /emitTurnControl\('steer_turn', \$event\)/);
  assert.match(surface, /emitTurnControl\('resolve_turn_control', undefined, \$event\)/);
  assert.match(shell, /desktopIpc\.supervisor\.controlTurn\(/);
  assert.match(shell, /desktopIpc\.supervisor\.resolveTurnControl\(/);
  assert.match(shell, /agentInspectorTurnControlActionId\(/);
  assert.match(shell, /agentInspectorTurnControlActionIdIfCurrent\(/);
  assert.doesNotMatch(shell, /controlTurn\(\{[\s\S]{0,500}actionId: globalThis\.crypto\.randomUUID\(\)/);
  assert.match(shell, /const correction = intent\.kind === "steer_turn" \? intent\.correction\?\.trim\(\) \|\| null : null/);
  assert.match(shell, /if \(intent\.kind === "steer_turn" && !correction\) throw new Error\("Write a correction before applying it\."\)/);
  assert.match(shell, /resolution: intent\.turnControlResolution/);
});

test("the Inspector fences stale control completions and makes uncertainty recoverable instead of retrying blindly", () => {
  assert.match(shell, /let turnControlFence: AgentInspectorTurnControlFence \| null = null/);
  assert.match(shell, /agentInspectorTurnControlFenceMatches\(turnControlFence, currentEntry, supervisorStatus\.value\?\.generation \?\? null\)/);
  assert.match(shell, /const currentEntryAfterDigest = agentInspectorProjections\.value\.find/);
  assert.match(shell, /currentAgentInspectorAction\(operationId, intent, requestVersion, operationDaemonGeneration\)/);
  assert.match(shell, /agentInspectorTurnControlFenceMatches\(exactTurnControlFence, currentEntryAfterDigest, supervisorStatus\.value\?\.generation \?\? null\)/);
  assert.match(shell, /inboxItemId: entry\.roomAgentState\?\.turn\.inboxItemId \?\? null/);
  assert.match(shell, /sourceMessageId: entry\.roomAgentState\?\.turn\.sourceMessageId \?\? null/);
  assert.match(control, /Mark as applied/);
  assert.match(control, /Mark as not applied/);
  assert.match(control, /Confirming “not applied” unlocks a new request; it never replays the old one\./);
  assert.doesNotMatch(control, /aria-live/, "the Inspector host owns one live region for action results");
});

test("turn actions stay contextual, keyboard-sized, and do not introduce broad motion", () => {
  assert.match(lifecycle, /action\.kind !== "stop_turn"/);
  assert.match(control, /Apply correction/);
  assert.match(control, /Stop current turn/);
  assert.match(styles, /\.agent-inspector-turn-control-actions button[\s\S]*?min-height: 44px;/);
  assert.doesNotMatch(styles, /\.agent-inspector-turn-control[\s\S]*transition:\s*all/i);
  assert.doesNotMatch(styles, /\.agent-inspector-turn-control[\s\S]*ease-in/i);
});
