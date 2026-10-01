import assert from "node:assert/strict";
import test from "node:test";

import type { AgentInspectorProjection } from "../src/domain/agent-inspector";
import { useAgentCorrectionHandoff } from "../src/components/desktop/content/room-shell/useAgentCorrectionHandoff";

function projection(entryId: string, canCorrect: boolean): AgentInspectorProjection {
  return {
    entryId,
    displayName: entryId,
    mentionInsertText: entryId,
    turnControl: canCorrect ? { status: "ready", canCorrect: true, providerTurnId: `turn_${entryId}` } : null,
  } as unknown as AgentInspectorProjection;
}

function harness() {
  const opened: string[] = [];
  const restored: string[] = [];
  const handoff = useAgentCorrectionHandoff({
    projections: () => [projection("busy", true), projection("idle", false)],
    openInspector: (target) => {
      opened.push(target.entryId);
      // Opening the Inspector releases whatever request came before, as the shell does.
      handoff.releaseCorrection({ restoreComposerText: true });
    },
    restoreComposerDraft: (draft) => { restored.push(draft); },
  });
  return { handoff, opened, restored };
}

test("composer text that was never applied goes back to the composer", () => {
  const { handoff, opened, restored } = harness();
  let cleared: boolean | null = null;
  handoff.openCorrectionFromComposer({ entryId: "busy", text: "stop and rebase", draft: "@busy stop and rebase" }, (value) => { cleared = value; });
  assert.equal(cleared, true);
  assert.deepEqual(opened, ["busy"]);
  assert.equal(handoff.correctionRequest.value?.text, "stop and rebase");
  assert.equal(handoff.correctionRequest.value?.providerTurnId, "turn_busy");

  handoff.releaseCorrection({ restoreComposerText: true });
  assert.deepEqual(restored, ["@busy stop and rebase"]);
  assert.equal(handoff.correctionRequest.value, null);
});

test("an applied correction keeps its text out of the composer", () => {
  const { handoff, restored } = harness();
  handoff.openCorrectionFromComposer({ entryId: "busy", text: "stop", draft: "@busy stop" }, () => undefined);
  handoff.releaseCorrection({ restoreComposerText: false });
  handoff.releaseCorrection({ restoreComposerText: true });
  assert.deepEqual(restored, []);
});

test("an agent without a correctable turn keeps the draft in the composer", () => {
  const { handoff, opened } = harness();
  let cleared: boolean | null = null;
  handoff.openCorrectionFromComposer({ entryId: "idle", text: "stop", draft: "@idle stop" }, (value) => { cleared = value; });
  assert.equal(cleared, false);
  assert.deepEqual(opened, []);
  assert.equal(handoff.openCorrection("missing"), false);
  assert.deepEqual(handoff.correctableAgents.value.map((target) => target.entryId), ["busy"]);
});
