import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { DesktopManagedAgentSession } from "../../electron/ipc-types";
import type { AgentInspectorSelection } from "../src/components/desktop/content/desktop-chat-message/types";
import { projectAgentInspectorParticipant } from "../src/domain/agent-inspector-participant";

function selection(overrides: Partial<AgentInspectorSelection> = {}): AgentInspectorSelection {
  return {
    kind: "external",
    actorLabel: "GardenSignal",
    displayName: "GardenSignal",
    ownerAttribution: "EmmyMay's agent",
    ideLabel: "Codex",
    sender: "GardenSignal",
    agentKey: "owner/garden-signal",
    agentSessionId: "session_garden",
    ...overrides,
  } as AgentInspectorSelection;
}

function session(overrides: Partial<DesktopManagedAgentSession> = {}): DesktopManagedAgentSession {
  return {
    id: "managed_garden",
    providerId: "codex",
    runtime: "codex",
    roomIdentifier: "room_a",
    roomDisplayName: null,
    repoRootPath: "/tmp/repo",
    repoBranch: null,
    status: "running",
    deliveryMode: "desktop_events",
    permissionProfileId: "full_access",
    permissionProfile: {
      id: "full_access",
      label: "Full access",
      description: "Trusted local access.",
      status: "available",
      risk: "high",
      detail: null,
      isDefault: true,
    },
    canStop: true,
    agentSessionId: "session_garden",
    actorLabel: "GardenSignal",
    agentKey: "owner/garden-signal",
    displayName: "GardenSignal",
    ownerLabel: "EmmyMay",
    ideLabel: "Codex",
    reasoningSessionId: null,
    activeWork: { kind: "message", eventId: "message_1", startedAt: "2026-07-23T07:00:00.000Z", summary: "Reviewing the room request" },
    pendingPermissionRequests: [],
    startedAt: "2026-07-23T07:00:00.000Z",
    updatedAt: "2026-07-23T07:00:00.000Z",
    lastError: null,
    supervisorEntryId: null,
    ...overrides,
  };
}

test("only one exact durable local session gains inspector controls", () => {
  const projected = projectAgentInspectorParticipant(selection(), [session()]);
  assert.equal(projected?.kind, "local_managed");
  assert.equal(projected?.kind === "local_managed" ? projected.canStopTurn : false, true);
  assert.equal(projected?.kind === "local_managed" ? projected.detail : null, "Reviewing the room request");
});

test("a true external participant is factual and read-only", () => {
  const projected = projectAgentInspectorParticipant(selection(), []);
  assert.deepEqual(projected, {
    kind: "external",
    title: "GardenSignal",
    eyebrow: "Room participant",
    heading: "Externally managed agent",
    detail: "This participant is visible in the room but is not controlled by this desktop.",
  });
});

test("duplicate and disagreeing identities fail closed to external read-only", () => {
  const duplicate = projectAgentInspectorParticipant(selection(), [session({ id: "one" }), session({ id: "two" })]);
  assert.equal(duplicate?.kind, "external");
  const disagreement = projectAgentInspectorParticipant(selection(), [
    session({ id: "session-owner", agentKey: "owner/one" }),
    session({ id: "key-owner", agentSessionId: "session_other" }),
  ]);
  assert.equal(disagreement?.kind, "external");
});

test("resolving and unavailable supervisor identity never produce a participant control surface", () => {
  assert.equal(projectAgentInspectorParticipant({ ...selection(), kind: "resolving" }, [session()]), null);
  assert.equal(projectAgentInspectorParticipant({ ...selection(), kind: "unavailable", unavailableReason: "ambiguous" }, [session()]), null);
  assert.equal(projectAgentInspectorParticipant({ ...selection(), kind: "unavailable", unavailableReason: "load_error" }, [session()]), null);
});

test("the responsive host has an exact 920px nonmodal boundary and compact accessibility treatment", async () => {
  const host = await readFile(new URL("../src/components/desktop/content/agent-inspector/AgentInspectorHost.vue", import.meta.url), "utf8");
  const css = await readFile(new URL("../src/components/desktop/content/agent-inspector/agent-inspector.css", import.meta.url), "utf8");
  assert.match(host, /width < compactBreakpoint/);
  assert.match(host, /const compactBreakpoint = 920/);
  assert.match(host, /setShellContentInert\(open && isCompact\)/);
  assert.match(host, /aria-live="polite" aria-atomic="true"/);
  assert.match(css, /@media \(min-width: 560px\) and \(max-width: 919px\)/);
  assert.match(css, /width: min\(640px, 88vw\)/);
  assert.match(css, /width: 100vw/);
  assert.match(css, /height: 100dvh/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.doesNotMatch(css, /transition:\s*all/);
  assert.doesNotMatch(css, /ease-in(?:[;,)\s])/);
  assert.doesNotMatch(css, /scale\(0\)/);
});
