import assert from "node:assert/strict";
import test from "node:test";
import type { DesktopSupervisorManifestEntry } from "../../electron/ipc-types";
import {
  participantAgentInspectorRequest,
  resolveAgentInspectorSelection,
  resolveSupervisorEntryId,
  supervisedAgentInspectorRequest,
  type SupervisorEntriesResource,
} from "../src/domain/agent-inspector-identity";
import type { AgentModalTarget } from "../src/components/desktop/content/desktop-chat-message/types";

function entry(overrides: Partial<DesktopSupervisorManifestEntry> = {}): DesktopSupervisorManifestEntry {
  return {
    id: "supervised_garden",
    roomId: "room_a",
    displayName: "GardenSignal",
    agentKey: "owner/garden-signal",
    provider: "codex",
    model: null,
    charter: "Help",
    desiredState: "running",
    observedState: "idle",
    condition: "none",
    permissionProfileId: null,
    deliveryMode: "daemon_inbox",
    createdBy: "EmmyMay",
    createdAt: "2026-07-22T10:00:00.000Z",
    workspacePath: null,
    workAttemptId: null,
    agentSessionId: "session_current",
    agentSessionBindingState: "historical",
    bindingUpdatedAt: null,
    executionGenerationId: null,
    providerContinuationId: null,
    providerPid: null,
    workplaceLiveness: { state: "unknown", observedAt: null, detail: null },
    nativeLiveness: { state: "unknown", observedAt: null, detail: null },
    restartCount: 0,
    lastTerminal: null,
    activity: [],
    turnControl: null,
    ...overrides,
  };
}

function target(overrides: Partial<AgentModalTarget> = {}): AgentModalTarget {
  return {
    actorLabel: "GardenSignal",
    displayName: "GardenSignal",
    ownerAttribution: "EmmyMay's agent",
    ideLabel: "Codex",
    sender: "GardenSignal",
    agentKey: "owner/garden-signal",
    agentSessionId: "session_current",
    ...overrides,
  };
}

function resource(
  state: SupervisorEntriesResource["state"],
  data: DesktopSupervisorManifestEntry[],
  error = "daemon unavailable",
): SupervisorEntriesResource {
  return state === "error"
    ? { state, roomIdentifier: "room_a", updatedAt: "2026-07-22T10:00:00.000Z", data, error }
    : state === "ready"
      ? { state, roomIdentifier: "room_a", updatedAt: "2026-07-22T10:00:00.000Z", data, error: null }
      : { state, roomIdentifier: "room_a", updatedAt: null, data, error: null };
}

test("a stale session resolves through one exact stable agent key", () => {
  const selection = resolveAgentInspectorSelection(
    resource("ready", [entry()]),
    participantAgentInspectorRequest(target({ agentSessionId: "session_stale" })),
    "room_a",
  );
  assert.equal(selection.kind, "supervised");
  assert.equal(selection.kind === "supervised" ? selection.supervisorEntryId : null, "supervised_garden");
});

test("display names and actor labels never resolve supervised identity", () => {
  const selection = resolveAgentInspectorSelection(
    resource("ready", [entry({ agentKey: "owner/other", agentSessionId: "session_other" })]),
    participantAgentInspectorRequest(target({ agentKey: null, agentSessionId: null })),
    "room_a",
  );
  assert.equal(selection.kind, "external");
});

test("same-label peers cannot cross-bind and generic provider keys are ignored", () => {
  const peers = [
    entry({ id: "one", agentKey: "owner/one", agentSessionId: "one" }),
    entry({ id: "two", agentKey: "owner/two", agentSessionId: "two" }),
  ];
  assert.equal(resolveAgentInspectorSelection(
    resource("ready", peers),
    participantAgentInspectorRequest(target({ agentKey: null, agentSessionId: null })),
    "room_a",
  ).kind, "external");
  assert.deepEqual(
    resolveSupervisorEntryId([entry({ agentKey: "codex" })], { agentKey: "codex", agentSessionId: null }),
    { state: "unmatched" },
  );
});

test("conflicting and duplicate stable identities fail closed", () => {
  const conflict = resolveAgentInspectorSelection(
    resource("ready", [
      entry({ id: "session_owner", agentKey: "owner/a", agentSessionId: "session_a" }),
      entry({ id: "key_owner", agentKey: "owner/b", agentSessionId: "session_b" }),
    ]),
    participantAgentInspectorRequest(target({ agentSessionId: "session_a", agentKey: "owner/b" })),
    "room_a",
  );
  assert.equal(conflict.kind, "unavailable");
  assert.equal(conflict.kind === "unavailable" ? conflict.unavailableReason : null, "ambiguous");

  assert.deepEqual(resolveSupervisorEntryId([
    entry({ id: "one" }),
    entry({ id: "two" }),
  ], { agentSessionId: "session_current", agentKey: null }), { state: "ambiguous" });
});

test("loading, refreshing, and failures never classify an unresolved participant as external", () => {
  const request = participantAgentInspectorRequest(target({ agentKey: null, agentSessionId: null }));
  assert.equal(resolveAgentInspectorSelection(resource("loading", []), request, "room_a").kind, "resolving");
  assert.equal(resolveAgentInspectorSelection(resource("refreshing", []), request, "room_a").kind, "resolving");
  const failed = resolveAgentInspectorSelection(resource("error", [entry()]), request, "room_a");
  assert.equal(failed.kind, "unavailable");
  assert.equal(failed.kind === "unavailable" ? failed.unavailableReason : null, "load_error");
});

test("a refresh failure retains and resolves an exact last-known supervised identity", () => {
  const selection = resolveAgentInspectorSelection(
    resource("error", [entry()]),
    participantAgentInspectorRequest(target()),
    "room_a",
  );
  assert.equal(selection.kind, "supervised");
});

test("direct Activity selections require the exact entry id and resource room", () => {
  const garden = entry();
  const request = supervisedAgentInspectorRequest(garden, { ownerAttribution: "EmmyMay's agent" });
  assert.equal(resolveAgentInspectorSelection(resource("ready", [garden]), request, "room_a").kind, "supervised");
  assert.equal(resolveAgentInspectorSelection(resource("ready", [garden]), request, "room_b").kind, "resolving");
  const missing = resolveAgentInspectorSelection(resource("ready", []), request, "room_a");
  assert.equal(missing.kind, "unavailable");
  assert.equal(missing.kind === "unavailable" ? missing.unavailableReason : null, "missing");
});

test("a retained direct request follows resource loss and recovery without identity inference", () => {
  const garden = entry();
  const request = supervisedAgentInspectorRequest(garden);
  assert.equal(resolveAgentInspectorSelection(resource("ready", [garden]), request, "room_a").kind, "supervised");
  assert.equal(resolveAgentInspectorSelection(resource("refreshing", []), request, "room_a").kind, "resolving");
  const missing = resolveAgentInspectorSelection(resource("ready", []), request, "room_a");
  assert.equal(missing.kind, "unavailable");
  assert.equal(missing.kind === "unavailable" ? missing.unavailableReason : null, "missing");
  assert.equal(resolveAgentInspectorSelection(resource("ready", [garden]), request, "room_a").kind, "supervised");
});
