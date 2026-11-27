import assert from "node:assert/strict";
import test from "node:test";
import type {
  DesktopAgentProvider,
  DesktopAgentProviderId,
  DesktopAgentProviderPreflight,
  DesktopManagedAgentPermissionProfile,
  DesktopSupervisorCreateInput,
} from "../../electron/ipc-types";
import {
  ONBOARDING_AGENT_DEFAULT_AVATAR,
  ONBOARDING_AGENT_CHARTER,
  ONBOARDING_AGENT_DEFAULT_NAME,
  firstRoomProgressKey,
  onboardingPermissionProfile,
  useOnboardingFirstRoom,
} from "../src/components/desktop/onboarding/useOnboardingFirstRoom";

function profile(id: DesktopManagedAgentPermissionProfile["id"], status: DesktopManagedAgentPermissionProfile["status"] = "available"): DesktopManagedAgentPermissionProfile {
  return { id, label: id, description: "", detail: "", risk: "low", status } as DesktopManagedAgentPermissionProfile;
}

function claude(): DesktopAgentProvider {
  return {
    id: "claude-code", name: "Claude Code", description: "", capabilities: ["supervised_runtime"], runtimeCommand: "claude",
    mcpTargetId: null, defaultPermissionProfileId: "ask_before_write",
    permissionProfiles: [profile("read_only"), profile("ask_before_write"), profile("full_access")],
  };
}

function preflight(status: DesktopAgentProviderPreflight["status"]): DesktopAgentProviderPreflight {
  return { providerId: "claude-code", status, canStart: status === "ready", message: status, detail: null, nextAction: null, version: null, mcpStatus: null };
}

function installBridge(options: { status?: DesktopAgentProviderPreflight["status"]; failCreateAgent?: number; holdRoom?: boolean } = {}) {
  const calls: string[] = [];
  const creates: DesktopSupervisorCreateInput[] = [];
  const preflights: unknown[] = [];
  let failures = options.failCreateAgent ?? 0;
  let status = options.status ?? "ready";
  let roomCount = 0;
  let releaseRoom: (() => void) | null = null;
  Object.assign(globalThis, {
    window: {
      crypto: globalThis.crypto,
      letagentsDesktop: {
        workers: {
          listAgentProviders: async () => [claude()],
          runAgentProviderPreflight: async (_id: DesktopAgentProviderId, input: unknown) => { preflights.push(input); return preflight(status); },
        },
        room: {
          createInviteRoom: async (input: { organizationId: string | null }) => {
            calls.push(`createInviteRoom ${input.organizationId}`);
            if (options.holdRoom) await new Promise<void>((resolve) => { releaseRoom = resolve; });
            roomCount += 1;
            const roomIdentifier = `room_${roomCount}`;
            return { roomIdentifier, code: "ABCD-1234", snapshot: { roomIdentifier, room: null } };
          },
          rename: async (roomIdentifier: string, name: string) => {
            calls.push(`rename ${roomIdentifier} ${name}`);
            return { roomIdentifier, displayName: name };
          },
        },
        supervisorGrant: { getStorageStatus: async () => ({ available: true, detail: "", canOpenCredentialStorage: false }) },
        supervisor: {
          createAgent: async (input: DesktopSupervisorCreateInput) => {
            creates.push(input);
            if (failures > 0) { failures -= 1; throw new Error("supervisor offline"); }
            return { id: `supervised_${input.creationRequestId}`, displayName: "Atlas 2", avatar: input.avatar, charter: input.charter };
          },
        },
      },
    },
  });
  return { calls, creates, preflights, setStatus: (next: typeof status) => { status = next; }, releaseRoom: () => releaseRoom?.() };
}

test("a new agent gets Add Agent's defaults in a room with no project", async () => {
  const bridge = installBridge();
  const firstRoom = useOnboardingFirstRoom();
  firstRoom.prepare("claude-code");
  assert.deepEqual(firstRoom.agent.value, { displayName: ONBOARDING_AGENT_DEFAULT_NAME, avatar: ONBOARDING_AGENT_DEFAULT_AVATAR });

  assert.equal(await firstRoom.run({ providerId: "claude-code", organizationId: "42" }), true);
  assert.equal(firstRoom.state.value, "done");
  assert.deepEqual(bridge.calls, ["createInviteRoom 42", "rename room_1 Welcome"]);
  assert.equal(firstRoom.room.value?.roomIdentifier, "room_1");
  assert.equal(firstRoom.room.value?.snapshot?.room?.displayName, "Welcome");
  assert.equal(bridge.creates.length, 1);
  const input = bridge.creates[0];
  assert.equal(input.roomIdentifier, "room_1");
  assert.equal(input.displayName, "Atlas");
  assert.deepEqual(input.avatar, ONBOARDING_AGENT_DEFAULT_AVATAR);
  assert.equal(input.repoRootPath, null);
  assert.equal(input.charter, ONBOARDING_AGENT_CHARTER);
  // The room shows it as the person's own first message: short, in their voice, and it asks what LetAgents is.
  assert.ok(input.charter.length <= 200);
  assert.match(input.charter, /what is LetAgents/);
  assert.equal(input.permissionProfileId, "read_only");
  assert.equal((input.launchPolicy as { permissionMode?: string }).permissionMode, "dontAsk");
  assert.equal(input.model, null);
  assert.equal(input.reasoningEffort, null);
  // The first check has no room yet; the agent step checks against the new room.
  assert.deepEqual(bridge.preflights, [{ roomOnly: true }, { roomOnly: true, roomIdentifier: "room_1" }]);
  // The background service owns the final name.
  assert.equal(firstRoom.agent.value?.displayName, "Atlas 2");
});

test("Cursor without a project falls back from sandboxed write like Add Agent", () => {
  const cursor: DesktopAgentProvider = {
    ...claude(), id: "cursor", name: "Cursor", defaultPermissionProfileId: "sandboxed_write",
    permissionProfiles: [profile("sandboxed_write"), profile("full_access")],
  };
  const { profile: chosen } = onboardingPermissionProfile(cursor);
  assert.notEqual(chosen?.status, "available", "workspace writes need a project");
});

test("a retry reuses the room and the creation request id", async () => {
  const bridge = installBridge({ failCreateAgent: 1 });
  const firstRoom = useOnboardingFirstRoom();
  assert.equal(await firstRoom.run({ providerId: "claude-code", organizationId: null }), false);
  assert.equal(firstRoom.state.value, "failed");
  assert.equal(firstRoom.task.value, "agent");
  assert.match(firstRoom.error.value!, /^Couldn't start Atlas: supervisor offline/);

  assert.equal(await firstRoom.run({ providerId: "claude-code", organizationId: null }), true);
  assert.deepEqual(bridge.calls.filter((call) => call.startsWith("createInviteRoom")), ["createInviteRoom null"]);
  assert.equal(bridge.creates.length, 2);
  assert.equal(bridge.creates[0].creationRequestId, bridge.creates[1].creationRequestId);
  assert.equal(bridge.creates[1].roomIdentifier, "room_1");

  // Done is done: a further run makes nothing new.
  assert.equal(await firstRoom.run({ providerId: "claude-code", organizationId: null }), true);
  assert.equal(bridge.creates.length, 2);
  assert.equal(bridge.calls.filter((call) => call.startsWith("createInviteRoom")).length, 1);
});

test("a second run while one is going shares it", async () => {
  const bridge = installBridge({ holdRoom: true });
  const firstRoom = useOnboardingFirstRoom();
  const first = firstRoom.run({ providerId: "claude-code", organizationId: null });
  const second = firstRoom.run({ providerId: "claude-code", organizationId: null });
  assert.equal(first, second);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(firstRoom.task.value, "room");
  bridge.releaseRoom();
  assert.equal(await first, true);
  assert.equal(bridge.calls.filter((call) => call.startsWith("createInviteRoom")).length, 1);
  assert.equal(bridge.creates.length, 1);
});

test("a provider that is not signed in fails the connect task clearly", async () => {
  const bridge = installBridge({ status: "auth_required" });
  const firstRoom = useOnboardingFirstRoom();
  assert.equal(await firstRoom.run({ providerId: "claude-code", organizationId: null }), false);
  assert.equal(firstRoom.task.value, "connect");
  assert.equal(firstRoom.error.value, "Claude Code is not signed in. Sign in, then try again.");
  assert.equal(bridge.calls.length, 0, "no room is made");

  bridge.setStatus("ready");
  assert.equal(await firstRoom.run({ providerId: "claude-code", organizationId: null }), true);
  firstRoom.reset();
  assert.equal(firstRoom.state.value, "idle");
  assert.equal(firstRoom.room.value, null);
});

function installStorage() {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
  return store;
}

test("a later try with another company reuses the first room", async () => {
  const bridge = installBridge({ failCreateAgent: 1 });
  const firstRoom = useOnboardingFirstRoom();
  assert.equal(await firstRoom.run({ providerId: "claude-code", organizationId: "42" }), false);
  assert.equal(await firstRoom.run({ providerId: "claude-code", organizationId: "77" }), true);
  assert.deepEqual(bridge.calls.filter((call) => call.startsWith("createInviteRoom")), ["createInviteRoom 42"]);
  assert.equal(bridge.creates[0].creationRequestId, bridge.creates[1].creationRequestId);
});

test("a quit between tries reuses the saved room and agent request, per account", async () => {
  const store = installStorage();
  const bridge = installBridge({ failCreateAgent: 1 });
  const key = firstRoomProgressKey({ authenticated: true, apiUrl: "https://letagents.chat", account: { id: "u1" } });
  assert.ok(key);
  const before = useOnboardingFirstRoom({ storageKey: () => key });
  assert.equal(await before.run({ providerId: "claude-code", organizationId: "42" }), false);
  assert.ok(store.get(key!), "progress is saved");

  // The app quit: a new screen for the same account.
  const after = useOnboardingFirstRoom({ storageKey: () => key });
  assert.equal(await after.run({ providerId: "claude-code", organizationId: "77" }), true);
  assert.equal(bridge.calls.filter((call) => call.startsWith("createInviteRoom")).length, 1, "no second Welcome room");
  assert.equal(after.room.value?.roomIdentifier, "room_1");
  assert.equal(bridge.creates[0].creationRequestId, bridge.creates[1].creationRequestId, "no second agent");

  // Another account starts its own room.
  const otherKey = firstRoomProgressKey({ authenticated: true, apiUrl: "https://letagents.chat", account: { id: "u2" } });
  const other = useOnboardingFirstRoom({ storageKey: () => otherKey });
  assert.equal(await other.run({ providerId: "claude-code", organizationId: null }), true);
  assert.equal(other.room.value?.roomIdentifier, "room_2");

  after.forget();
  assert.equal(store.get(key!), undefined, "finished setup drops its progress");
  assert.equal(firstRoomProgressKey({ authenticated: false, account: { id: "u1" } }), null);
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

test("a reset during a run waits for the run, then clears the screen", async () => {
  const bridge = installBridge({ holdRoom: true });
  const firstRoom = useOnboardingFirstRoom();
  const run = firstRoom.run({ providerId: "claude-code", organizationId: null });
  await new Promise((resolve) => setImmediate(resolve));
  firstRoom.reset();
  bridge.releaseRoom();
  await run;
  assert.equal(firstRoom.state.value, "idle");
  assert.equal(firstRoom.room.value, null);
});
