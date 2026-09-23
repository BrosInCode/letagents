import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ref } from "vue";
import type { SupervisorEntriesResource } from "../src/domain/agent-inspector-identity";
import { useAgentInspectorObservations } from "../src/components/desktop/content/room-shell/useAgentInspectorObservations";
import { fileURLToPath } from "node:url";
import {
  AGENT_INSPECTOR_DIAGNOSTICS_EVENT_LIMIT,
  AGENT_INSPECTOR_DIAGNOSTICS_REPORT_LIMIT,
  agentInspectorDiagnosticsReport,
  projectAgentInspectorDiagnostics,
  sanitizeAgentInspectorDiagnosticsValue,
} from "../src/domain/agent-inspector-diagnostics";

const CANARY = "super-secret-canary-value";

function projection(activity: unknown[] = []): any {
  return { entry: {
    id: "supervised_1", roomId: "room_1", agentKey: "emmymay/gardensignal", provider: "codex", model: "gpt-5.6", createdAt: "2026-07-23T10:00:00.000Z",
    desiredState: "running", observedState: "working", condition: "none", lastError: `Authorization: Bearer ${CANARY}`,
    agentSessionBindingState: "active", providerPid: 712, executionGenerationId: "generation_1", restartCount: 1,
    workplaceLiveness: { state: "healthy" }, nativeLiveness: { state: "healthy" },
    lastTerminal: { output: CANARY }, activity, roomAgentState: { connection: { state: "connected" }, ingress: { state: "observing" }, inbox: { state: "empty" }, turn: { state: "idle" } }, turnControl: null,
  } };
}

function event(sequence: number, payload: unknown): any {
  return { observedAt: `2026-07-23T10:00:${String(sequence).padStart(2, "0")}.000Z`, sequence, provider: "codex", kind: "notification", method: "item/started", summary: `Progress ${sequence}`, status: "working", payload, payloadTruncated: false, payloadRedacted: false, durablePayloadRef: `durable://${CANARY}` };
}

test("diagnostics recursively redacts secret values and caps cyclic/deep/large payloads", () => {
  const cyclic: Record<string, unknown> = { token: CANARY, nested: { password: CANARY, note: "safe" }, long: "x".repeat(2_000) };
  cyclic.self = cyclic;
  const value = sanitizeAgentInspectorDiagnosticsValue(cyclic);
  const text = JSON.stringify(value.value);
  assert.match(text, /\[REDACTED\]/);
  assert.match(text, /\[CIRCULAR\]/);
  assert.doesNotMatch(text, new RegExp(CANARY));
  assert.equal(value.redacted, true);
  assert.equal(value.truncated, true);
});

test("diagnostics redacts secrets embedded in arbitrary string leaves", () => {
  const cases = [
    `{"authorization":"Bearer ${CANARY}"}`,
    `"{\\"authorization\\":\\"Bearer ${CANARY}\\"}"`,
    `authorization: "Bearer ${CANARY}"`,
    `password='${CANARY}'`,
    `OPENAI_API_KEY="${CANARY}"`,
    `AWS_SECRET_ACCESS_KEY=${CANARY}`,
    `NPM_TOKEN='${CANARY}'`,
    `SLACK_BOT_TOKEN: "${CANARY}"`,
    `export SENTRY_AUTH_TOKEN=${CANARY}`,
    `{"CLOUDFLARE_API_TOKEN":"${CANARY}"}`,
    `"{\\"GITHUB_APP_PRIVATE_KEY\\":\\"${CANARY}\\"}"`,
    `STRIPE_SECRET_KEY=\\"${CANARY}\\"`,
    `Cookie: session=${CANARY}; theme=dark`,
    `https://user:${CANARY}@example.com/private`,
    `Bearer ${CANARY}`,
    `-----BEGIN PRIVATE KEY-----\n${CANARY}\n-----END PRIVATE KEY-----`,
    `-----BEGIN ENCRYPTED PRIVATE KEY-----\n${CANARY}\n-----END ENCRYPTED PRIVATE KEY-----`,
    `-----BEGIN RSA PRIVATE KEY-----\n${CANARY}\n-----END RSA PRIVATE KEY-----`,
    `-----BEGIN OPENSSH PRIVATE KEY-----\n${CANARY}\n-----END OPENSSH PRIVATE KEY-----`,
    `-----BEGIN EC PRIVATE KEY-----\n${CANARY}\n-----END EC PRIVATE KEY-----`,
    `-----BEGIN PGP PRIVATE KEY BLOCK-----\n${CANARY}\n-----END PGP PRIVATE KEY BLOCK-----`,
  ];
  for (const hostile of cases) {
    const result = sanitizeAgentInspectorDiagnosticsValue(hostile);
    assert.doesNotMatch(JSON.stringify(result.value), new RegExp(CANARY), hostile);
    assert.equal(result.redacted, true, hostile);
  }
});

test("encrypted PKCS#8 is redacted from escaped string leaves and copied reports", () => {
  const encryptedPrivateKey = `-----BEGIN ENCRYPTED PRIVATE KEY-----\n${CANARY}\n-----END ENCRYPTED PRIVATE KEY-----`;
  const escapedPrivateKey = JSON.stringify(encryptedPrivateKey);
  const leaf = sanitizeAgentInspectorDiagnosticsValue(escapedPrivateKey);
  assert.equal(leaf.redacted, true);
  assert.doesNotMatch(JSON.stringify(leaf.value), new RegExp(CANARY));

  const source = projection([{ ...event(1, escapedPrivateKey), summary: escapedPrivateKey }]);
  source.entry.lastError = escapedPrivateKey;
  const result = projectAgentInspectorDiagnostics(source);
  assert.doesNotMatch(result.activity[0]?.summary ?? "", new RegExp(CANARY));
  assert.doesNotMatch(result.activity[0]?.payloadPreview ?? "", new RegExp(CANARY));
  assert.doesNotMatch(result.recovery.lastError ?? "", new RegExp(CANARY));
  assert.doesNotMatch(agentInspectorDiagnosticsReport(result), new RegExp(CANARY));
});

test("diagnostics preserves benign identifier near-misses", () => {
  const benign = {
    TOKEN_COUNT: CANARY,
    AUTH_STATUS: CANARY,
    COOKIE_POLICY: CANARY,
    ACCESS_KEY_ID: CANARY,
    PUBLIC_KEY: CANARY,
    SSH_PUBLIC_KEY: CANARY,
    CLIENT_ID: CANARY,
    COMPASS: CANARY,
    SECRETARY: CANARY,
    KEYBOARD_LAYOUT: CANARY,
  };
  const structured = sanitizeAgentInspectorDiagnosticsValue(benign);
  assert.equal(structured.redacted, false);
  assert.equal(JSON.stringify(structured.value).match(new RegExp(CANARY, "g"))?.length, Object.keys(benign).length);
  const text = sanitizeAgentInspectorDiagnosticsValue("TOKEN_COUNT=7 AUTH_STATUS=ready COMPASS=north PUBLIC_KEY=visible");
  assert.equal(text.redacted, false);
  assert.equal(text.value, "TOKEN_COUNT=7 AUTH_STATUS=ready COMPASS=north PUBLIC_KEY=visible");
});

test("diagnostics keeps only newest bounded activity and never exposes raw terminal or durable references", () => {
  const events = Array.from({ length: AGENT_INSPECTOR_DIAGNOSTICS_EVENT_LIMIT + 5 }, (_, index) => event(index + 1, { authorization: `Bearer ${CANARY}`, durablePayloadRef: `ref:${CANARY}` }));
  const result = projectAgentInspectorDiagnostics(projection(events));
  assert.equal(result.activity.length, AGENT_INSPECTOR_DIAGNOSTICS_EVENT_LIMIT);
  assert.equal(result.activity[0]?.sequence, events.length);
  assert.equal(result.activityTruncated, true);
  const text = JSON.stringify(result);
  assert.doesNotMatch(text, new RegExp(CANARY));
  assert.doesNotMatch(text, /durable:\/\//);
  assert.equal(result.activity[0]?.redacted, true);
});

test("projected summaries, last errors, and copied reports cannot leak string-encoded credentials", () => {
  const source = projection([
    {
      ...event(1, `{"SLACK_BOT_TOKEN":"${CANARY}"}`),
      summary: `NPM_TOKEN="${CANARY}"`,
    },
  ]);
  source.entry.lastError = `"{\\"AWS_SECRET_ACCESS_KEY\\":\\"${CANARY}\\"}"`;
  const result = projectAgentInspectorDiagnostics(source);
  assert.doesNotMatch(result.recovery.lastError ?? "", new RegExp(CANARY));
  assert.doesNotMatch(result.activity[0]?.summary ?? "", new RegExp(CANARY));
  assert.doesNotMatch(result.activity[0]?.payloadPreview ?? "", new RegExp(CANARY));
  assert.doesNotMatch(agentInspectorDiagnosticsReport(result), new RegExp(CANARY));
});

test("copy report is allowlisted and bounded even when every event is hostile", () => {
  const events = Array.from({ length: AGENT_INSPECTOR_DIAGNOSTICS_EVENT_LIMIT }, (_, index) => event(index + 1, { secret: CANARY, huge: "x".repeat(20_000) }));
  const report = agentInspectorDiagnosticsReport(projectAgentInspectorDiagnostics(projection(events)));
  assert.ok(report.length <= AGENT_INSPECTOR_DIAGNOSTICS_REPORT_LIMIT);
  assert.match(report, /letagents-agent-diagnostics-v1/);
  assert.doesNotMatch(report, new RegExp(CANARY));
  assert.doesNotMatch(report, /lastTerminal|durablePayloadRef/);
});

test("the diagnostics tab is lazy and participates in roving Home/End tab behavior", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/components/desktop/content/agent-inspector/AgentInspectorSurface.vue", import.meta.url)), "utf8");
  assert.match(source, /defineAsyncComponent\(\(\) => import\("\.\/AgentInspectorDiagnostics\.vue"\)\)/);
  assert.match(source, /v-else id="agent-inspector-diagnostics-panel"/);
  assert.match(source, /<button id="agent-inspector-diagnostics-tab"/);
  // The Live tab sits between Overview and Work; Diagnostics stays the End target.
  assert.match(source, /\["overview", "live", "work", "workspace", "settings", "diagnostics"\]/);
  assert.match(source, /event\.key === 'End' \? 'diagnostics'/);
});

test("the high-frequency diagnostics copy action has no transform motion", () => {
  const styles = readFileSync(fileURLToPath(new URL("../src/components/desktop/content/agent-inspector/agent-inspector-diagnostics.css", import.meta.url)), "utf8");
  assert.doesNotMatch(styles, /\.agent-inspector-diagnostics-copy[^{}]*\{[^}]*transition:[^;}]*transform/s);
  assert.doesNotMatch(styles, /\.agent-inspector-diagnostics-copy:active\s*\{[^}]*transform/s);
});

// Troubleshooting must explain separate truths and reuse exact existing actions.
import { projectAgentInspector } from "../src/domain/agent-inspector";
import { projectAgentTroubleshooting } from "../src/domain/agent-inspector-troubleshooting";

function diagnosticFixture() {
  const entry = {
    ...projection().entry, runtimeGenerationId: "runtime_1", workAttemptId: "attempt_1",
    agentSessionId: "session_1", providerContinuationId: "thread_1", lastError: null,
    createdBy: "EmmyMay", displayName: "GardenSignal", charter: "Investigate failures", workspacePath: "/tmp/work",
    lastTurnControlSequence: 0, deliveryMode: "daemon_inbox", deliveryReceipts: [],
    roomAgentState: {
      connection: { state: "connected", detail: null, observedAt: "2026-09-14T10:00:00Z" },
      ingress: { state: "observing", detail: null, observedAt: "2026-09-14T10:00:00Z" },
      inbox: { state: "empty", pendingCount: 0, blockedByMessageId: null, detail: null },
      turn: { state: "idle", inboxItemId: null, sourceMessageId: null, providerTurnId: null, detail: null },
      task: { state: "none", taskId: null, title: null },
    },
  } as any;
  const daemon = { healthy: true, generation: 3, capabilities: { agentRuntimeRecovery: true } } as any;
  const resource = { status: "ready", error: null, sourceMessageId: null, detail: {
    entry_id: entry.id, room_id: entry.roomId, runtime_control: {
      runtime_generation_id: "runtime_1", execution_generation_id: entry.executionGenerationId,
      daemon_generation_id: "3", control_state: "responsive", runtime_state: "ready", observed_at: "2026-09-14T10:00:00Z",
    }, uncertain_effects: [], receipt: null,
  } } as any;
  const project = (freshness: "fresh" | "stale" = "fresh") => projectAgentInspector(entry, {
    roomId: entry.roomId, resourceFreshness: freshness, deliveryRetryAvailable: true,
    continuationRepairAvailable: true, roomDeliverySkipAvailable: true,
  });
  const assess = (freshness: "fresh" | "stale" = "fresh") => projectAgentTroubleshooting(project(freshness), resource, daemon);
  return { entry, daemon, resource, project, assess };
}

test("an unknown working runtime has explicit recovery choices without claiming a failure", () => {
  const fixture = diagnosticFixture();
  fixture.daemon.capabilities.agentRuntimeRecoveryV2 = true;
  fixture.resource.detail.runtime_control = null;
  fixture.entry.roomAgentState.ingress.state = "backoff";
  const result = fixture.assess();
  assert.equal(result.checks[1]!.state, "unknown");
  assert.match(result.checks[1]!.nextStep, /Reconnect.*restart and resume/);
  const choices = fixture.project().actions.filter(action => ["reconnect_runtime", "restart_runtime", "fresh_runtime"].includes(action.kind));
  assert.equal(choices.length, 3);
  assert.ok(choices.every(choice => choice.available));
  assert.ok(choices.filter(choice => choice.kind !== "reconnect_runtime").every(choice => choice.danger));
  assert.ok(fixture.project("stale").actions.filter(action => choices.some(choice => choice.kind === action.kind)).every(choice => !choice.available));
});

test("unfinished recovery offers only its exact recorded restart, including after fresh intent cleared the old reference", () => {
  const fixture = diagnosticFixture();
  fixture.entry.desiredState = "paused";
  fixture.entry.executionGenerationId = null;
  fixture.entry.runtimeGenerationId = null;
  fixture.entry.runtimeRecovery = { mode: "fresh", phase: "stopped", operationId: "operation",
    roomId: fixture.entry.roomId, executionGenerationId: "old-execution", runtimeGenerationId: "old-runtime" };
  const result = fixture.assess();
  assert.equal(result.checks[1]!.summary, "Recovery is paused");
  const choices = fixture.project().actions;
  assert.equal(choices.find(action => action.kind === "resume")?.available, false);
  assert.equal(choices.find(action => action.kind === "reconnect_runtime")?.available, false);
  assert.equal(choices.find(action => action.kind === "restart_runtime")?.available, false);
  assert.equal(choices.find(action => action.kind === "fresh_runtime")?.available, true);
  assert.equal(choices.find(action => action.kind === "fresh_runtime")?.label, "Continue fresh start");
});

test("healthy checks distinguish connectivity from message completion", () => {
  const result = diagnosticFixture().assess();
  assert.equal(result.passedCount, 4);
  assert.equal(result.state, "passed");
  assert.match(result.checks[3]!.detail, /does not mean every earlier request succeeded/);
  assert.equal(result.checks[3]!.destination, "work");
});

test("stale snapshots never display cached checks as healthy or offer recovery", () => {
  const result = diagnosticFixture().assess("stale");
  assert.equal(result.primaryCheckId, "service");
  assert.equal(result.passedCount, 0);
  assert.ok(result.checks.every(check => check.state === "unknown" && check.action === null));
});

test("daemon reachability does not mask a lost provider", () => {
  const fixture = diagnosticFixture();
  fixture.daemon.capabilities.agentRuntimeRecoveryV2 = true;
  fixture.resource.detail.runtime_control.control_state = "lost";
  fixture.entry.observedState = "failed";
  fixture.entry.nativeLiveness.state = "terminal";
  const result = fixture.assess();
  assert.equal(result.checks[0]!.state, "passed");
  assert.equal(result.checks[1]!.state, "attention");
  assert.equal(result.primaryCheckId, "provider");
  assert.equal(result.checks[1]!.action?.kind, "recovery_options");
  fixture.daemon.capabilities.agentRuntimeRecoveryV2 = false;
  assert.equal(fixture.assess().checks[1]!.action, null,
    "an older service cannot turn an exact-runtime choice into implicit recovery");
  fixture.entry.runtimeGenerationId = null;
  assert.equal(fixture.assess().checks[1]!.action?.kind, "recover", "legacy terminal-runtime recovery remains available");
  fixture.daemon.capabilities.agentRuntimeRecovery = false;
  assert.equal(fixture.assess().checks[1]!.action, null);
});

test("silence, a missing PID, and inconclusive checks never authorize a restart", () => {
  for (const state of ["degraded", "unprobeable"]) {
    const fixture = diagnosticFixture();
    fixture.entry.provider = "cursor";
    fixture.entry.providerPid = null;
    fixture.resource.detail.runtime_control.control_state = state;
    const check = fixture.assess().checks[1]!;
    assert.equal(check.state, "unknown");
    assert.equal(check.action, null);
    assert.doesNotMatch(check.summary, /stopped/i);
  }
});

test("provider health is fenced by daemon, execution, runtime, entry, and room identity", () => {
  for (const key of ["daemon_generation_id", "execution_generation_id", "runtime_generation_id"]) {
    const fixture = diagnosticFixture();
    fixture.resource.detail.runtime_control[key] = "obsolete";
    assert.equal(fixture.assess().checks[1]!.state, "unknown", key);
  }
  for (const key of ["entry_id", "room_id"]) {
    const fixture = diagnosticFixture();
    fixture.resource.detail[key] = "other";
    assert.equal(fixture.assess().checks[1]!.state, "unknown", key);
  }
  const fixture = diagnosticFixture();
  fixture.resource.status = "error";
  assert.equal(fixture.assess().checks[1]!.state, "unknown");
});

test("room credential recovery explains the running provider separately", () => {
  const fixture = diagnosticFixture();
  fixture.entry.observedState = "recovering";
  fixture.entry.lastError = "Restoring room access (retrying automatically)";
  fixture.entry.roomAgentState.inbox.state = "waiting_for_desktop_credentials";
  const result = fixture.assess();
  assert.equal(result.checks[1]!.state, "passed");
  assert.equal(result.checks[2]!.state, "pending");
  assert.match(result.checks[2]!.detail, /restoring this agent’s room access automatically/);
  fixture.resource.detail.runtime_control.control_state = "lost";
  assert.doesNotMatch(fixture.assess().checks[2]!.detail, /provider is running/i);
  assert.equal(result.checks[2]!.action, null);
});

test("a generic auth blocker does not invent which credentials failed", () => {
  const fixture = diagnosticFixture();
  fixture.entry.condition = "auth_blocked";
  const check = fixture.assess().checks[2]!;
  assert.equal(check.state, "attention");
  assert.match(check.detail, /provider sign-in or room access/);
  assert.equal(check.action, null);
});

test("paused and retired agents are intentional holds, not healthy or failed runtimes", () => {
  const fixture = diagnosticFixture();
  fixture.entry.desiredState = "paused";
  assert.equal(fixture.assess().checks[1]!.state, "paused");
  assert.equal(fixture.assess().checks[1]!.action?.kind, "resume");
  fixture.entry.desiredState = "stopped";
  assert.equal(fixture.assess().checks[1]!.action, null);
});

test("conversation repair targets only the exact eligible blocked message", () => {
  const fixture = diagnosticFixture();
  fixture.entry.roomAgentState.inbox = { state: "blocked", pendingCount: 2, blockedByMessageId: "msg_1", detail: null };
  fixture.entry.deliveryReceipts = [{ state: "blocked", failureCode: "provider_continuation_missing", sourceMessageId: "msg_1", attemptCount: 0, providerTurnId: null, fifoSequence: 1, timeline: [] }];
  const check = fixture.assess().checks[3]!;
  assert.equal(check.action?.kind, "restore_conversation");
  assert.equal(check.action?.sourceMessageId, "msg_1");
  assert.match(check.actionImpact!, /private context cannot be recovered/);
  fixture.entry.deliveryReceipts[0].attemptCount = 1;
  assert.equal(fixture.assess().checks[3]!.action, null);
});

test("uncertain side effects suppress retry and send the user to evidence", () => {
  const fixture = diagnosticFixture();
  fixture.entry.roomAgentState.inbox.state = "blocked";
  fixture.resource.detail.uncertain_effects = [{ tool_name: "publish" }];
  const check = fixture.assess().checks[3]!;
  assert.equal(check.state, "attention");
  assert.equal(check.action, null);
  assert.equal(check.destination, "work");
  assert.match(check.nextStep, /verify/);
});

test("retry schedules are only shown from fresh, exact retained receipts", () => {
  const fixture = diagnosticFixture();
  fixture.entry.roomAgentState.turn.sourceMessageId = "msg_1";
  fixture.resource.detail.requested_source_message_id = "msg_1";
  fixture.resource.detail.receipt = { state: "retryable", next_attempt_at_ms: Date.parse("2026-09-14T10:01:00Z") };
  assert.equal(fixture.assess().nextAttemptAt, "2026-09-14T10:01:00.000Z");
  assert.equal(fixture.assess("stale").nextAttemptAt, null);
  fixture.resource.status = "error";
  assert.equal(fixture.assess().nextAttemptAt, null);
  fixture.resource.status = "ready";
  for (const state of ["acknowledged", "acknowledged_failed", "acknowledged_no_reply", "cancelled_by_user", "blocked"]) {
    fixture.resource.detail.receipt.state = state;
    assert.equal(fixture.assess().nextAttemptAt, null, state);
  }
  fixture.resource.detail.receipt.state = "retryable";
  fixture.resource.detail.requested_source_message_id = "older_message";
  assert.equal(fixture.assess().nextAttemptAt, null);
  fixture.resource.detail.requested_source_message_id = "msg_1";
  fixture.resource.detail.receipt.next_attempt_at_ms = Infinity;
  assert.equal(fixture.assess().nextAttemptAt, null);
});

test("new explanations and report extensions retain the redaction boundary", () => {
  const fixture = diagnosticFixture();
  fixture.entry.roomAgentState.inbox.detail = `NPM_TOKEN=${CANARY}`;
  assert.doesNotMatch(JSON.stringify(fixture.assess()), new RegExp(CANARY));
  const report = agentInspectorDiagnosticsReport(projectAgentInspectorDiagnostics(fixture.project()), {
    conversationRepair: { error: `Authorization: Bearer ${CANARY}` }, runtime: { secret: CANARY },
    huge: "x".repeat(100_000),
  });
  assert.doesNotMatch(report, new RegExp(CANARY));
  assert.ok(report.length <= AGENT_INSPECTOR_DIAGNOSTICS_REPORT_LIMIT);
});

function observationFixture() {
  const fixture = diagnosticFixture();
  let version = 0;
  const calls: string[] = [];
  const options = {
    selectedProjection: ref(fixture.project()), requestVersion: ref(1), daemonStatus: ref(fixture.daemon),
    workSource: ref<string | null>(null), workResource: ref(fixture.resource), entriesState: ref<SupervisorEntriesResource["state"]>("ready"), entriesError: ref<string | null>(null),
    observationVersion: () => String(version),
    refreshStatus: async () => { calls.push("status"); return fixture.daemon; },
    readAgents: async room => { calls.push(`agents:${room}`); return [fixture.entry]; },
    loadDetail: async (source, follow) => { calls.push(`detail:${source}:${follow}`); },
    upsert: (_entry, request) => { calls.push(`upsert:${request}`); version++; },
  } satisfies Parameters<typeof useAgentInspectorObservations>[0];
  return { fixture, options, calls, push: () => { version++; }, ...useAgentInspectorObservations(options) };
}

test("explicit checks read status, exact agent, and settled work in order", async () => {
  const test = observationFixture();
  assert.equal(await test.refreshDiagnostics(), true);
  assert.deepEqual(test.calls, ["status", "agents:room_1", "upsert:1", "detail:null:false"]);
});

test("failed explicit observations invalidate cached freshness without deleting evidence", async () => {
  for (const failure of ["status", "agents", "missing"] as const) {
    const test = observationFixture();
    const retained = test.options.selectedProjection.value;
    if (failure === "status") test.options.refreshStatus = async () => null;
    else test.options.readAgents = async () => { if (failure === "agents") throw new Error("Unavailable"); return []; };
    assert.equal(await test.refreshDiagnostics(), false, failure);
    assert.equal(test.options.entriesState.value, "error");
    assert.match(test.options.entriesError.value!, /Couldn’t refresh/);
    assert.equal(test.options.selectedProjection.value, retained);
  }
});

test("newer pushes and selection changes win over failed or late manual reads", async () => {
  for (const change of ["push", "selection"] as const) {
    const test = observationFixture();
    test.options.readAgents = async () => {
      if (change === "push") test.push(); else test.options.requestVersion.value++;
      throw new Error("Late failure");
    };
    assert.equal(await test.refreshDiagnostics(), false);
    assert.equal(test.options.entriesState.value, "ready", change);
  }
  const test = observationFixture();
  test.options.readAgents = async () => { test.push(); return [test.fixture.entry]; };
  assert.equal(await test.refreshDiagnostics(), true);
  assert.equal(test.calls.some(call => call.startsWith("upsert")), false);
});

test("verification never accepts an unsettled or discarded detail read", async () => {
  for (const state of ["loading", "refreshing", "error", "idle", "ready", "unavailable"] as const) {
    const test = observationFixture();
    test.options.loadDetail = async () => { test.fixture.resource.status = state; };
    assert.equal(await test.refreshDiagnostics(), ["ready", "unavailable"].includes(state), state);
  }
});

test("verification rejects changed agent, runtime, daemon, source, or stale evidence", async () => {
  for (const change of ["selection", "execution", "runtime", "daemon", "source", "stale"] as const) {
    const test = observationFixture();
    test.options.loadDetail = async () => {
      if (change === "selection") test.options.requestVersion.value++;
      if (change === "execution") test.options.selectedProjection.value!.entry.executionGenerationId = "replacement";
      if (change === "runtime") test.options.selectedProjection.value!.entry.runtimeGenerationId = "replacement";
      if (change === "daemon") test.options.daemonStatus.value = { ...test.fixture.daemon, generation: 4 };
      if (change === "source") test.options.workSource.value = "new_message";
      if (change === "stale") test.options.selectedProjection.value!.resourceFreshness = "stale";
    };
    assert.equal(await test.refreshDiagnostics(), false, change);
  }
});

test("opening Work or Diagnostics defaults to the current active message when none is selected", () => {
  const test = observationFixture();
  test.options.selectedProjection.value!.entry.roomAgentState!.turn.sourceMessageId = "current_message";
  test.openWork();
  assert.equal(test.options.workSource.value, "current_message");
  assert.deepEqual(test.calls, ["detail:current_message:true"]);
});

test("returning to Work or opening Diagnostics preserves the selected historical message", () => {
  const test = observationFixture();
  test.options.workSource.value = "historical_message";
  test.options.selectedProjection.value!.entry.roomAgentState!.turn.sourceMessageId = "current_message";
  test.options.workResource.value.detail!.items = [
    { source_message_id: "current_message" }, { source_message_id: "historical_message" },
  ];
  test.openWork();
  assert.equal(test.options.workSource.value, "historical_message");
  assert.deepEqual(test.calls, ["detail:historical_message:false"]);
});
