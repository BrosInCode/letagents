import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import {
  createRenderer,
  defineComponent,
  effectScope,
  h,
  isReadonly,
  nextTick,
  ref,
  reactive,
  watch,
  type App,
} from "vue";
import type {
  DesktopRoomMessage,
  DesktopRoomThreadInboxPage,
  DesktopSupervisorManifestEntry,
  DesktopSupervisorStateSnapshot,
} from "../../electron/ipc-types";
import {
  normalizeExactGitHubUrl,
  normalizeGitHubObjectUrl,
  repoRepositoryFromRoomIdentifier,
  shouldPreviewComposerEvent,
  shouldRefreshEventsForMessage,
  useDesktopRoomGitHubEvents,
} from "../src/components/desktop/content/room-shell/useDesktopRoomGitHubEvents";
import { mergeThreadInboxPages } from "../src/composables/useNeedsYou";
import { useSupervisorStateSubscription } from "../src/components/desktop/content/room-shell/useSupervisorStateSubscription";
import { useRoomAttentionNavigation } from "../src/components/desktop/content/room-shell/useRoomAttentionNavigation";
import type { AttentionNavigationIntent, RoomTabId } from "../src/components/desktop/content/room-shell/types";

const shellSource = read("../src/components/desktop/content/DesktopRoomShell.vue");
const githubEventsSource = read("../src/components/desktop/content/room-shell/useDesktopRoomGitHubEvents.ts");

test("the desktop room shell keeps GitHub events and no longer owns an inbox", () => {
  assert.ok(shellSource.split("\n").length < 3_000);
  assert.doesNotMatch(shellSource, /useDesktopRoomInbox|RoomInboxView|id: "inbox"/);
  assert.match(shellSource, /useDesktopRoomGitHubEvents\(/);
  assert.doesNotMatch(shellSource, /desktopIpc\.room\.getThreads/);
  assert.doesNotMatch(shellSource, /desktopIpc\.room\.getGitHubEvents/);
  assert.doesNotMatch(shellSource, /letagents-desktop:room-inbox-seen/);
  assert.match(githubEventsSource, /desktopIpc\.room\.getGitHubEvents/);
  assert.match(githubEventsSource, /parseGitHubEvent/);
});

test("extracted room shell domains do not import the shell component", () => {
  assert.doesNotMatch(githubEventsSource, /DesktopRoomShell/);
});

test("thread inbox paging preserves replacement and cursor semantics", () => {
  const current = {
    threads: [thread("root-1", "old"), thread("root-2", "keep")],
    hasMore: true,
    unreadThreadCount: 2,
  } as unknown as DesktopRoomThreadInboxPage;
  const next = {
    threads: [thread("root-1", "new"), thread("root-3", "append")],
    hasMore: false,
    unreadThreadCount: 1,
  } as unknown as DesktopRoomThreadInboxPage;

  const merged = mergeThreadInboxPages(current, next);

  assert.deepEqual(merged.threads.map((item) => [item.root.id, item.root.text]), [
    ["root-1", "new"],
    ["root-2", "keep"],
    ["root-3", "append"],
  ]);
  assert.equal(merged.hasMore, false);
  assert.equal(merged.unreadThreadCount, 1);
});

test("GitHub room and event routing keeps exact and object URL identities distinct", () => {
  assert.equal(repoRepositoryFromRoomIdentifier("github.com/BrosInCode/letagents"), "BrosInCode/letagents");
  assert.equal(repoRepositoryFromRoomIdentifier("local-room"), null);
  assert.equal(normalizeExactGitHubUrl(" HTTPS://GitHub.com/A/B/issues/1/ "), "https://github.com/a/b/issues/1");
  assert.equal(normalizeGitHubObjectUrl("https://github.com/a/b/issues/1?notification=2#x"), "https://github.com/a/b/issues/1");

  const githubMessage = { source: "GitHub", sender: "bot", timestamp: "2026-08-12T12:00:00.000Z" } as DesktopRoomMessage;
  assert.equal(shouldRefreshEventsForMessage(githubMessage), true);
  assert.equal(shouldPreviewComposerEvent(githubMessage, Date.parse("2026-08-12T12:00:29.999Z")), true);
  assert.equal(shouldPreviewComposerEvent(githubMessage, Date.parse("2026-08-12T12:00:30.000Z")), false);
});

test("mounted GitHub events owns readonly selection and resets it on room change", async () => {
  installWindow({ room: {} }, []);
  const room = ref({ identifier: "github.com/a/one" } as never);
  const activeTab = ref<"chat" | "events">("chat");
  let githubEvents!: ReturnType<typeof useDesktopRoomGitHubEvents>;
  const mounted = mountHarness(() => {
    githubEvents = useDesktopRoomGitHubEvents({
      room,
      messages: ref([]),
      initialPage: ref(null),
      activeTab,
      localGitRoom: ref(false),
      githubConnected: ref(true),
      connectedRepository: ref(null),
    });
  });

  githubEvents.openEventsForTask("task-1");
  githubEvents.openEventById("event-1");
  assert.equal(githubEvents.eventsTaskFilterId.value, null);
  assert.equal(githubEvents.eventsSelectedEventId.value, "event-1");
  assert.equal(activeTab.value, "events");
  assert.equal(isReadonly(githubEvents.eventsTaskFilterId), true);
  assert.equal(isReadonly(githubEvents.eventsSelectedEventId), true);

  room.value = { identifier: "github.com/a/two" } as never;
  await nextTick();
  assert.equal(githubEvents.eventsTaskFilterId.value, null);
  assert.equal(githubEvents.eventsSelectedEventId.value, null);
  mounted.unmount();
});

test("supervisor room subscriptions reject detached callbacks and queued frames through A to B to A", () => {
  const fixture = supervisorSubscriptionFixture();
  try {
    fixture.controls.mount();
    const firstA = fixture.subscriptions[0]!;
    assert.equal(firstA.roomIdentifier, "room-a");
    firstA.callback(stateSnapshot(4));
    const staleFrame = fixture.controls.state().frame!;
    fixture.controls.navigate("room-b");
    assert.equal(firstA.stops, 1);
    assert.ok(fixture.cancelledFrames.has(staleFrame));
    assert.equal(fixture.controls.state().pending, null);
    assert.equal(fixture.controls.state().lastSnapshot, null);
    firstA.callback(stateSnapshot(50));
    assert.equal(fixture.controls.state().lastSnapshot, null, "old callback cannot mark a new room fresh");

    const roomB = fixture.subscriptions[1]!;
    assert.equal(roomB.roomIdentifier, "room-b");
    const snapshotB = stateSnapshot(5);
    roomB.callback(snapshotB);
    const frameB = fixture.controls.state().frame!;
    fixture.frames.get(staleFrame)!();
    assert.equal(fixture.controls.state().frame, frameB, "canceled old frame cannot clear the new frame");
    assert.equal(fixture.controls.state().pending, snapshotB);
    fixture.frames.get(frameB)!();
    assert.deepEqual(fixture.accepted, [snapshotB]);

    fixture.controls.navigate("room-a");
    firstA.callback(stateSnapshot(100));
    roomB.callback(stateSnapshot(101));
    assert.equal(fixture.controls.state().pending, null, "same-room return does not revive an old subscription");
    assert.equal(fixture.controls.state().lastSnapshot, null);
    assert.equal(fixture.subscriptions.filter((subscription) => subscription.stops === 0).length, 1);
    const currentA = stateSnapshot(6);
    fixture.subscriptions[2]!.callback(currentA);
    fixture.frames.get(fixture.controls.state().frame!)!();
    assert.deepEqual(fixture.accepted, [snapshotB, currentA]);
  } finally { fixture.dispose(); }
});

test("supervisor scoped subscription preserves queue ordering, empty updates and unmount cleanup", () => {
  const fixture = supervisorSubscriptionFixture();
  try {
  fixture.controls.mount();
  const subscription = fixture.subscriptions[0]!;
  subscription.callback(stateSnapshot(10));
  const frame = fixture.controls.state().frame!;
  subscription.callback(stateSnapshot(9));
  subscription.callback({ ...stateSnapshot(100), daemonGeneration: 6 });
  assert.equal(fixture.controls.state().pending?.sequence, 10);
  const nextGeneration = { ...stateSnapshot(1), daemonGeneration: 8 };
  subscription.callback(nextGeneration);
  assert.equal(fixture.controls.state().frame, frame);
  fixture.frames.get(frame)!();
  assert.deepEqual(fixture.accepted, [nextGeneration], "new generation and empty entries are not suppressed");

  subscription.callback(stateSnapshot(100));
  fixture.frames.get(fixture.controls.state().frame!)!();
  subscription.callback({ ...stateSnapshot(0), daemonGeneration: 8 });
  fixture.frames.get(fixture.controls.state().frame!)!();
  assert.deepEqual(fixture.accepted, [nextGeneration], "accepted generation/sequence cannot regress after a frame commits");

  subscription.callback({ ...stateSnapshot(2), daemonGeneration: 8 });
  const pendingFrame = fixture.controls.state().frame!;
  fixture.dispose();
  assert.ok(fixture.cancelledFrames.has(pendingFrame));
  assert.equal(subscription.stops, 1);
  assert.equal(fixture.controls.state().active, false);
  assert.equal(fixture.controls.state().pending, null);
  assert.equal(fixture.controls.state().lastSnapshot, null);
  subscription.callback({ ...stateSnapshot(3), daemonGeneration: 8 });
  fixture.frames.get(pendingFrame)!();
  fixture.controls.navigate("room-b");
  assert.equal(fixture.subscriptions.length, 1);
  assert.deepEqual(fixture.accepted, [nextGeneration]);
  // Disposing again only restores the mocked window if an assertion above failed first.
  } finally { fixture.dispose(); }
});

test("Inbox deep links open where the item can be acted on, and an agent link waits for the room's agents", async () => {
  const intent = ref<AttentionNavigationIntent | null>(null);
  const loading = ref(false);
  const agentsSettled = ref(false);
  const activeTab = ref<RoomTabId>("events");
  const boardGovernanceSection = ref<"pending" | null>(null);
  const calls: string[] = [];
  const agents = [{ id: "supervised_copper" }] as DesktopSupervisorManifestEntry[];
  const scope = effectScope();
  scope.run(() => useRoomAttentionNavigation({
    intent: () => intent.value, roomIdentifier: () => "room-a", roomLoading: () => loading.value,
    agentsSettled: () => agentsSettled.value, agents: () => agents, activeTab, boardGovernanceSection,
    openBoardTask: (id) => calls.push(`task:${id}`), openThread: (id) => calls.push(`thread:${id}`),
    openEvent: (id, url) => calls.push(`event:${id}:${url}`), openReasoning: (id) => calls.push(`reasoning:${id}`),
    revealMessage: (id) => calls.push(`message:${id}`), openAgentDiagnostics: (entry) => calls.push(`diagnostics:${entry.id}`),
    // App clears the intent once the room reports it opened.
    opened: () => { calls.push("opened"); intent.value = null; },
  }));
  const open = async (next: Omit<AttentionNavigationIntent, "roomIdentifier">, roomIdentifier = "room-a") => {
    calls.length = 0; intent.value = { roomIdentifier, ...next }; await nextTick();
  };
  try {
    await open({ boardRequests: true });
    assert.equal(boardGovernanceSection.value, "pending", "a board request opens Manager on Requests");
    assert.equal(activeTab.value, "board");
    assert.deepEqual(calls, ["opened"]);
    await open({ approvals: true });
    assert.equal(activeTab.value, "chat", "an approval opens Chat, where its card is docked");

    await open({ agentEntryId: "supervised_copper" });
    assert.deepEqual(calls, [], "an agent link waits for the room's agents");
    agentsSettled.value = true; await nextTick();
    assert.deepEqual(calls, ["diagnostics:supervised_copper", "opened"]);
    activeTab.value = "chat";
    await open({ agentEntryId: "supervised_gone" });
    assert.equal(activeTab.value, "activity", "an agent that is gone is shown in Activity");

    for (const [next, expected] of [
      [{ taskId: "task_7" }, "task:task_7"], [{ threadRootId: "msg_1" }, "thread:msg_1"],
      [{ eventId: "event_1", eventUrl: "https://github.com/a/b/pull/1" }, "event:event_1:https://github.com/a/b/pull/1"],
      [{ reasoningSessionId: "session_1" }, "reasoning:session_1"], [{ messageId: "msg_2" }, "message:msg_2"],
    ] as const) {
      await open(next);
      assert.deepEqual(calls, [expected, "opened"]);
    }

    await open({ taskId: "task_8" }, "room-b");
    assert.deepEqual(calls, [], "an item for another room waits for that room");
    intent.value = null; loading.value = true;
    await open({ taskId: "task_9" });
    assert.deepEqual(calls, [], "nothing opens while the room is loading");
    loading.value = false; await nextTick();
    assert.deepEqual(calls, ["task:task_9", "opened"]);
  } finally { scope.stop(); }
});

function stateSnapshot(sequence: number): DesktopSupervisorStateSnapshot {
  return { daemonGeneration: 7, sequence, entries: [] };
}

/** Run the room's actual subscription composable, wired as the shell wires it,
 * with the shell's own snapshot-accept code, inert bridge and RAF boundaries,
 * without importing its application services or mounting a UI. */
function supervisorSubscriptionFixture() {
  const script = shellSource.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1]!;
  const parsed = ts.createSourceFile("DesktopRoomShell.ts", script, ts.ScriptTarget.Latest, true);
  const variableNames = new Set(["supervisorStateDaemonGeneration", "supervisorStateSequence", "supervisorEntriesMutationVersion"]);
  const source = parsed.statements.filter((statement) =>
    (ts.isVariableStatement(statement) && statement.declarationList.declarations.some((declaration) => variableNames.has(declaration.name.getText(parsed))))
    || (ts.isFunctionDeclaration(statement) && statement.name?.text === "acceptSupervisorStateSnapshot")
  ).map((statement) => statement.getText(parsed)).join("\n");
  assert.match(shellSource, /useSupervisorStateSubscription\(\{ roomIdentifier: \(\) => props\.room\.identifier, accept: acceptSupervisorStateSnapshot \}\)/);
  assert.match(shellSource, /watch\(\(\) => props\.room\.identifier, supervisorStateSubscription\.sync, \{ flush: "sync" \}\)/);
  assert.match(shellSource, /onMounted\([\s\S]*?supervisorStateSubscription\.mount\(\)/);
  assert.match(shellSource, /onBeforeUnmount\([\s\S]*?supervisorStateSubscription\.unmount\(\)/);
  const roomChange = /watch\(\(\) => props\.room\.identifier, \(\) => \{([\s\S]*?)\n\}, \{ immediate: true \}\);/.exec(shellSource)?.[1] ?? "";
  assert.match(roomChange, /boardGovernanceSection\.value = null;/, "a room switch clears a pending Board > Manager > Requests request");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const subscriptions: Array<{ roomIdentifier?: string; callback: (snapshot: DesktopSupervisorStateSnapshot) => void; stops: number }> = [];
  const frames = new Map<number, () => void>();
  const cancelledFrames = new Set<number>();
  const accepted: DesktopSupervisorStateSnapshot[] = [];
  const props = reactive({ room: { identifier: "room-a" } });
  const accept = runInNewContext(`${compiled}\nacceptSupervisorStateSnapshot;`, {
    props,
    supervisorStatus: { value: { generation: 7 } },
    supervisorEntries: { value: [] },
    supervisorEntriesHaveLoaded: { value: false },
    supervisorEntriesUpdatedAt: { value: null },
    supervisorEntriesState: { value: "loading" },
    supervisorEntriesError: { value: null },
    selectedAgentDetailTarget: { value: null },
    mergeSupervisorStateSnapshotEntries: (_current: unknown, next: unknown) => next,
    refreshSupervisorStatus: async () => undefined,
    refreshOpenAgentInspectorRuntimeControl: () => undefined,
    reconcilePendingRetirementFromDurableState: (snapshot: DesktopSupervisorStateSnapshot) => accepted.push(snapshot),
  }) as (snapshot: DesktopSupervisorStateSnapshot) => void;
  const priorWindow = (globalThis as { window?: unknown }).window;
  Object.assign(globalThis, { window: {
    letagentsDesktop: { supervisor: { onState(callback: (snapshot: DesktopSupervisorStateSnapshot) => void, roomIdentifier?: string) {
      const subscription = { callback, roomIdentifier, stops: 0 };
      subscriptions.push(subscription);
      return () => { subscription.stops += 1; };
    } } },
    requestAnimationFrame(callback: () => void) { const id = frames.size + 1; frames.set(id, callback); return id; },
    cancelAnimationFrame(id: number) { cancelledFrames.add(id); },
  } });
  const scope = effectScope();
  const subscription = scope.run(() => {
    const room = useSupervisorStateSubscription({ roomIdentifier: () => props.room.identifier, accept });
    watch(() => props.room.identifier, room.sync, { flush: "sync" });
    return room;
  })!;
  const controls = {
    mount: subscription.mount,
    navigate(roomIdentifier: string) { props.room.identifier = roomIdentifier; },
    unmount: subscription.unmount,
    state() { const state = subscription.state(); return { active: state.active, lastSnapshot: state.lastSnapshotAtMs, pending: state.pending, frame: state.frame }; },
  };
  return { controls, subscriptions, frames, cancelledFrames, accepted, dispose() {
    controls.unmount(); scope.stop(); Object.assign(globalThis, { window: priorWindow });
  } };
}

function thread(id: string, text: string) {
  return { root: { id, text }, summary: { unreadCount: 1 } };
}

interface HostNode { parent: HostNode | null; children: HostNode[] }

const renderer = createRenderer<HostNode, HostNode>({
  patchProp: () => undefined,
  insert(child, parent) { parent.children.push(child); child.parent = parent; },
  remove(child) { child.parent?.children.splice(child.parent.children.indexOf(child), 1); },
  createElement: () => ({ parent: null, children: [] }),
  createText: () => ({ parent: null, children: [] }),
  createComment: () => ({ parent: null, children: [] }),
  setText: () => undefined,
  setElementText: () => undefined,
  parentNode: (node) => node.parent,
  nextSibling: () => null,
  insertStaticContent: (_content, parent) => {
    const node = { parent, children: [] };
    parent.children.push(node);
    return [node, node];
  },
});

function mountHarness(setup: () => void): App<HostNode> {
  const app = renderer.createApp(defineComponent({
    setup() { setup(); return () => h("div"); },
  }));
  app.mount({ parent: null, children: [] });
  return app;
}

function installWindow(api: Record<string, unknown>, clearedTimers: unknown[]): void {
  const storage = new Map<string, string>();
  Object.assign(globalThis, {
    window: {
      letagentsDesktop: api,
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
      setTimeout,
      clearTimeout: (timer: unknown) => {
        clearedTimers.push(timer);
        clearTimeout(timer as ReturnType<typeof setTimeout>);
      },
    },
  });
}

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}
