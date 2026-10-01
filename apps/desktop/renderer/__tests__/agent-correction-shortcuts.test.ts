import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createSSRApp, h, type Component } from "vue";
import { renderToString } from "@vue/server-renderer";
import { createServer, type ViteDevServer } from "vite";

import type { DesktopSupervisorManifestEntry } from "../../electron/ipc-types";
import {
  agentCorrectionTargets,
  mentionedCorrectionTarget,
  projectAgentInspector,
  type AgentInspectorProjection,
} from "../src/domain/agent-inspector";

let vite: ViteDevServer;
let TurnControl: Component;
let ActivityTab: Component;

before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL("../..", import.meta.url)),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  TurnControl = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/agent-inspector/AgentInspectorTurnControl.vue")).default;
  ActivityTab = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/RoomActivityTabView.vue")).default;
});
after(async () => { await vite?.close(); });

function entry(id: string, displayName: string, responding: boolean): DesktopSupervisorManifestEntry {
  return {
    id, roomId: "focus_1", displayName, agentKey: `emmymay/${displayName.toLowerCase()}`, provider: "codex", model: null,
    charter: "Investigate failures.", desiredState: "running", observedState: "working", condition: "none", lastError: null,
    permissionProfileId: null, deliveryMode: "daemon_inbox", createdBy: "EmmyMay", createdAt: "2026-10-01T09:00:00.000Z",
    workspacePath: "/tmp/ws", workAttemptId: `attempt_${id}`, agentSessionId: `session_${id}`, agentSessionBindingState: "active",
    bindingUpdatedAt: "2026-10-01T09:00:00.000Z", executionGenerationId: `generation_${id}`, providerContinuationId: `continuation_${id}`,
    providerPid: 123, workplaceLiveness: { state: "healthy", observedAt: "2026-10-01T10:00:00.000Z", detail: null },
    nativeLiveness: { state: "healthy", observedAt: "2026-10-01T10:00:00.000Z", detail: null }, restartCount: 0, lastTerminal: null,
    activity: [],
    roomAgentState: {
      connection: { state: "connected", observedAt: "2026-10-01T10:00:00.000Z", detail: null },
      ingress: { state: "observing", observedAt: "2026-10-01T10:00:00.000Z", detail: null },
      inbox: { state: "empty", pendingCount: 0, blockedByMessageId: null, detail: null },
      turn: responding
        ? { state: "responding", inboxItemId: `inbox_${id}`, sourceMessageId: `message_${id}`, providerTurnId: `turn_${id}`, detail: null }
        : { state: "idle", inboxItemId: null, sourceMessageId: null, providerTurnId: null, detail: null },
      task: { state: "none", taskId: null, title: null },
    },
    deliveryReceipts: [],
    lastTurnControlSequence: 0,
    turnControl: null,
  } as DesktopSupervisorManifestEntry;
}

function project(candidate: DesktopSupervisorManifestEntry, resourceFreshness: "fresh" | "stale" = "fresh"): AgentInspectorProjection {
  return projectAgentInspector(candidate, {
    roomId: "focus_1",
    resourceFreshness,
    mentionInsertTextByEntryId: new Map([[candidate.id, candidate.displayName]]),
  })!;
}

const busy = project(entry("supervised_busy", "LunarAmber", true));
const idle = project(entry("supervised_idle", "HarborMarsh", false));

test("only an agent with a live, correctable turn is offered as a correction target", () => {
  assert.deepEqual(agentCorrectionTargets([busy, idle]), [
    { entryId: "supervised_busy", displayName: "LunarAmber", mentionInsertText: "LunarAmber" },
  ]);
  // Without live supervisor state the turn cannot be changed, so no shortcut.
  assert.deepEqual(agentCorrectionTargets([project(entry("supervised_busy", "LunarAmber", true), "stale")]), []);
});

test("a draft that mentions one busy agent becomes that agent's correction without the mention", () => {
  const targets = agentCorrectionTargets([busy, idle]);
  assert.deepEqual(mentionedCorrectionTarget("@LunarAmber check out e10c9ea and rerun only the msg_270 check", targets), {
    target: targets[0],
    text: "check out e10c9ea and rerun only the msg_270 check",
  });
  assert.equal(mentionedCorrectionTarget("@lunaramber, stop the write.", targets)?.text, "stop the write.");
  assert.equal(mentionedCorrectionTarget("Please @LunarAmber: rebase first", targets)?.text, "Please rebase first");
  // An idle agent, an e-mail-like token, a bare mention and no mention are all plain room messages.
  assert.equal(mentionedCorrectionTarget("@HarborMarsh please review", targets), null);
  assert.equal(mentionedCorrectionTarget("mail test@LunarAmber now", targets), null);
  assert.equal(mentionedCorrectionTarget("@LunarAmber ", targets), null);
  assert.equal(mentionedCorrectionTarget("status update for the room", targets), null);
  // Two busy agents are ambiguous: a correction reaches one private session.
  const second = { entryId: "supervised_other", displayName: "SparrowReef", mentionInsertText: "SparrowReef" };
  assert.equal(mentionedCorrectionTarget("@LunarAmber @SparrowReef stop", [...targets, second]), null);
});

test("Activity offers Correct on the busy agent's row only", async () => {
  const html = await renderToString(createSSRApp({
    render: () => h(ActivityTab, {
      recentActivity: [], participants: [], liveClearedCount: 0, presence: [], reasoningSessions: [], roomGitRoom: null,
      roomIdentifier: "focus_1", roomArtifacts: [], roomAgentWork: [], roomAgentWorkStatus: "idle", roomAgentWorkTruncated: false,
      activityHistoryRequest: 0, artifactTaskFilterId: null, tasks: [], messages: [], workers: [],
      supervisorEntries: [busy.entry, idle.entry], agentProjections: [busy, idle],
    }),
  }));
  const actions = [...html.matchAll(/data-testid="desktop-activity-correct-agent"/g)];
  assert.equal(actions.length, 1);
  assert.match(html, /aria-label="Correct LunarAmber(?:&#39;|')s current turn"/);
  assert.doesNotMatch(html, /Correct HarborMarsh/);
});

test("text handed over as a correction lands in the box only for the turn it was meant for", async () => {
  const render = (providerTurnId: string | null) => renderToString(createSSRApp({
    render: () => h(TurnControl, {
      entryId: busy.entryId,
      control: busy.turnControl,
      busy: false,
      correctionRequest: { id: 1, entryId: busy.entryId, providerTurnId, text: "Stop the write and rebase on main." },
    }),
  }));
  assert.match(await render("turn_supervised_busy"), /<textarea[^>]*>Stop the write and rebase on main\.<\/textarea>/);
  // A newer turn started since the person chose "Send as correction".
  assert.doesNotMatch(await render("turn_older"), /Stop the write and rebase on main/);
});
