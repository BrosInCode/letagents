import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { compile } from "@vue/compiler-dom";
import { parse } from "@vue/compiler-sfc";
import * as Vue from "vue";
import { computed, createRenderer, defineComponent, getCurrentInstance, h, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, reactive, ref, toRefs } from "vue";
import { useKeyWhileShown } from "../src/composables/useKeyWhileShown";

// App.vue keeps the open room shell in a KeepAlive so that hiding the room
// (Settings, Inbox, company home) and showing the same room again keeps scroll
// position and composer state. A room switch must still unmount the old shell.
// Vue 3.5's KeepAlive with `max: 1` and a keyed child loses the old child when
// the parent re-renders with the same key before the key changes. That
// re-render mounts a clone of KeepAlive's `current` vnode. On the switch the
// pruned entry is the current one, so Vue resets the keep-alive flag on the
// original `current` only; the mounted clone keeps the flag and is deactivated
// instead of unmounted. Nothing unmounts it later, so every switch kept a whole
// room alive.
//
// App.vue therefore keys the KeepAlive itself by the last shown room
// (`useKeyWhileShown`). A key change that happens only while the room view is
// hidden (a focus room's snapshot falls back to the parent while Settings is
// open) must not destroy the hidden room.

const appSource = readFileSync(fileURLToPath(new URL("../src/App.vue", import.meta.url)), "utf8");

function roomShellKeepAliveTemplate(): string {
  const template = parse(appSource).descriptor.template!.content;
  const blocks = template.match(/<KeepAlive\b[\s\S]*?<\/KeepAlive>/g) ?? [];
  assert.equal(blocks.length, 1, "App.vue has one KeepAlive block");
  assert.match(blocks[0]!, /<DesktopRoomShell\b/, "the KeepAlive block holds the room shell");
  return blocks[0]!;
}

// The harness builds the two names the KeepAlive block reads the way App.vue's
// script does; these checks keep the two in step.
test("App.vue derives the KeepAlive key and the shell's v-if as the harness does", () => {
  const script = parse(appSource).descriptor.scriptSetup!.content.replace(/\s+/g, " ");
  assert.ok(script.includes(
    `const roomShellShown = computed(() => !showCompanyHome.value && activeEntry.value.type === "room" && !selectedNeedsAccess.value);`,
  ), "roomShellShown matches the harness");
  assert.ok(script.includes("const roomShellKeepAliveKey = useKeyWhileShown(roomShellShown, selectedRoomRenderKey);"));
  assert.match(roomShellKeepAliveTemplate(), /<KeepAlive :key="roomShellKeepAliveKey"/);
  assert.match(roomShellKeepAliveTemplate(), /v-if="roomShellShown"/);
});

type FakeNode = { kind: string; parent: FakeNode | null; children: FakeNode[]; text?: string };

function fakeNode(kind: string, text?: string): FakeNode {
  return { kind, parent: null, children: [], text };
}

function detach(node: FakeNode) {
  if (!node.parent) return;
  const siblings = node.parent.children;
  siblings.splice(siblings.indexOf(node), 1);
  node.parent = null;
}

// A tiny tree is enough for KeepAlive: it moves the shell into its storage
// container on deactivate and back on activate.
const renderer = createRenderer<FakeNode, FakeNode>({
  patchProp() {},
  insert(child, parent, anchor) {
    detach(child);
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    if (index < 0) parent.children.push(child);
    else parent.children.splice(index, 0, child);
    child.parent = parent;
  },
  remove: detach,
  createElement: (tag) => fakeNode(tag),
  createText: (text) => fakeNode("#text", text),
  createComment: (text) => fakeNode("#comment", text),
  setText(node, text) { node.text = text; },
  setElementText(node, text) { node.children = []; node.text = text; },
  parentNode: (node) => node.parent,
  nextSibling(node) {
    if (!node.parent) return null;
    const siblings = node.parent.children;
    return siblings[siblings.indexOf(node) + 1] ?? null;
  },
});

type ShellEvent = { room: string; event: "mounted" | "activated" | "deactivated" | "unmounted" };

function mountRoomShellHost(options: { hidden?: boolean } = {}) {
  const events: ShellEvent[] = [];
  const live = new Set<string>();
  let nextInstance = 0;
  const DesktopRoomShell = defineComponent({
    name: "DesktopRoomShell",
    inheritAttrs: false,
    setup() {
      const instance = getCurrentInstance()!;
      const room = `${String(instance.vnode.key)}#${++nextInstance}`;
      onMounted(() => { live.add(room); events.push({ room, event: "mounted" }); });
      onActivated(() => events.push({ room, event: "activated" }));
      onDeactivated(() => events.push({ room, event: "deactivated" }));
      onUnmounted(() => { live.delete(room); events.push({ room, event: "unmounted" }); });
      return () => h("div");
    },
  });

  const { code } = compile(roomShellKeepAliveTemplate(), { mode: "function", prefixIdentifiers: true, hoistStatic: true });
  const render = new Function("Vue", code)(Vue);
  const state = reactive({
    showCompanyHome: options.hidden === true,
    activeEntry: { type: "room", id: "room-a" },
    selectedNeedsAccess: false,
    // Inputs of `selectedRoomRenderKey` (useAppSidebarSelection.ts): the
    // selected room id first, then the snapshot's room.
    selectedRoomIdentifier: "room-a",
    snapshotRoomIdentifier: "room-a",
    selectedRoomInfo: { identifier: "room-a", displayName: "", name: "room-a" },
    selectedSnapshotLoading: false,
    roomSettingsSectionRequestFor: () => null,
    chatScrollPositionForRoom: () => null,
  });
  const Host = defineComponent({
    components: { DesktopRoomShell },
    setup() {
      const selectedRoomRenderKey = computed(() =>
        state.selectedRoomIdentifier || state.snapshotRoomIdentifier || state.activeEntry.id);
      const roomShellShown = computed(() =>
        !state.showCompanyHome && state.activeEntry.type === "room" && !state.selectedNeedsAccess);
      const roomShellKeepAliveKey = useKeyWhileShown(roomShellShown, selectedRoomRenderKey);
      return { ...toRefs(state), selectedRoomRenderKey, roomShellShown, roomShellKeepAliveKey };
    },
    render,
  });

  const app = renderer.createApp(Host);
  const errors: string[] = [];
  app.config.errorHandler = (error) => { errors.push(error instanceof Error ? error.message : String(error)); };
  app.config.warnHandler = () => {};
  const root = fakeNode("root");
  app.mount(root);
  return { app, state, events, live, errors };
}

type HostState = ReturnType<typeof mountRoomShellHost>["state"];

function selectRoom(state: HostState, room: string) {
  state.activeEntry = { type: "room", id: room };
  state.selectedRoomIdentifier = room;
  state.snapshotRoomIdentifier = room;
  state.selectedRoomInfo = { identifier: room, displayName: "", name: room };
}

async function switchRoom(state: HostState, room: string) {
  // The app re-renders the shell's parent while the same room stays open (a
  // snapshot load flag, a new message), and only then the room changes.
  state.selectedSnapshotLoading = !state.selectedSnapshotLoading;
  await nextTick();
  selectRoom(state, room);
  await nextTick();
}

function countOf(events: ShellEvent[], event: ShellEvent["event"]) {
  return events.filter((entry) => entry.event === event).length;
}

test("a room switch unmounts the old room shell after a same-room re-render", async () => {
  const { app, state, events, live, errors } = mountRoomShellHost();
  await nextTick();
  assert.deepEqual([...live], ["room-a#1"]);

  await switchRoom(state, "room-b");

  assert.ok(
    events.some((entry) => entry.room === "room-a#1" && entry.event === "unmounted"),
    `the old room shell runs its unmount hook (events: ${JSON.stringify(events)})`,
  );
  assert.deepEqual([...live], ["room-b#2"], "only the open room shell stays alive");
  assert.deepEqual(errors, []);
  app.unmount();
});

test("many room switches keep one live room shell", async () => {
  const { app, state, live, errors } = mountRoomShellHost();
  await nextTick();
  for (let index = 0; index < 12; index += 1) {
    await switchRoom(state, `room-${index % 3}`);
    assert.equal(live.size, 1, `one live room shell after switch ${index + 1}`);
  }
  assert.deepEqual(errors, []);
  app.unmount();
  assert.equal(live.size, 0, "app unmount removes the last room shell");
});

test("hiding and showing the same room keeps the same shell alive", async () => {
  const { app, state, events, live, errors } = mountRoomShellHost();
  await nextTick();
  state.selectedSnapshotLoading = true;
  await nextTick();

  state.showCompanyHome = true;
  await nextTick();
  assert.deepEqual([...live], ["room-a#1"], "the hidden room shell stays alive");
  assert.equal(events.at(-1)?.event, "deactivated");

  state.showCompanyHome = false;
  await nextTick();
  assert.deepEqual([...live], ["room-a#1"], "the same shell comes back");
  assert.equal(events.at(-1)?.event, "activated");
  assert.equal(countOf(events, "mounted"), 1, "the room is not mounted again");
  assert.equal(countOf(events, "unmounted"), 0);
  assert.deepEqual(errors, []);
  app.unmount();
});

test("a key that changes only while the room is hidden and comes back keeps the hidden shell", async () => {
  const { app, state, events, live, errors } = mountRoomShellHost();
  await nextTick();
  state.selectedSnapshotLoading = true;
  await nextTick();

  state.showCompanyHome = true;
  await nextTick();
  state.selectedRoomIdentifier = "";
  state.snapshotRoomIdentifier = "room-x";
  await nextTick();
  state.selectedRoomIdentifier = "room-a";
  state.snapshotRoomIdentifier = "room-a";
  await nextTick();
  state.showCompanyHome = false;
  await nextTick();

  assert.deepEqual([...live], ["room-a#1"], `the same shell comes back (events: ${JSON.stringify(events)})`);
  assert.equal(countOf(events, "mounted"), 1);
  assert.equal(countOf(events, "unmounted"), 0);
  assert.equal(events.at(-1)?.event, "activated");
  assert.deepEqual(errors, []);
  app.unmount();
});

test("focus room, then Settings, then back keeps the focus room shell", async () => {
  // Reviewer's path: useAppSelectionWatchers calls refreshSelectedSnapshot for
  // the Settings entry; its non-room branch swaps the snapshot to the parent
  // room, so selectedRoomRenderKey moves to the parent while the focus room is
  // hidden, and moves back when the focus room is selected again.
  const { app, state, events, live, errors } = mountRoomShellHost();
  await nextTick();
  await switchRoom(state, "focus-a");
  state.selectedSnapshotLoading = true;
  await nextTick();
  assert.deepEqual([...live], ["focus-a#2"]);

  state.activeEntry = { type: "system", id: "settings" };
  state.selectedRoomIdentifier = "";
  await nextTick();
  state.snapshotRoomIdentifier = "room-parent";
  await nextTick();
  assert.deepEqual([...live], ["focus-a#2"], "Settings only hides the focus room");

  state.activeEntry = { type: "room", id: "focus-a" };
  state.selectedRoomIdentifier = "focus-a";
  await nextTick();
  state.snapshotRoomIdentifier = "focus-a";
  await nextTick();

  assert.deepEqual([...live], ["focus-a#2"], `the focus room shell comes back (events: ${JSON.stringify(events)})`);
  assert.equal(events.filter((entry) => entry.room === "focus-a#2" && entry.event === "mounted").length, 1);
  assert.equal(events.at(-1)?.event, "activated");
  assert.deepEqual(errors, []);
  app.unmount();
});

test("a room change that stays while the room is hidden unmounts the hidden room on show", async () => {
  const { app, state, events, live, errors } = mountRoomShellHost();
  await nextTick();
  state.selectedSnapshotLoading = true;
  await nextTick();
  state.showCompanyHome = true;
  await nextTick();
  selectRoom(state, "room-b");
  await nextTick();
  assert.deepEqual([...live], ["room-a#1"], "the hidden room waits until the room view shows again");

  state.showCompanyHome = false;
  await nextTick();
  assert.deepEqual([...live], ["room-b#2"], "the hidden room is unmounted and the new room is mounted");
  assert.ok(events.some((entry) => entry.room === "room-a#1" && entry.event === "unmounted"));
  assert.deepEqual(errors, []);
  app.unmount();
});

test("a room view hidden at first mount shows its room once, and switches still unmount", async () => {
  const { app, state, events, live, errors } = mountRoomShellHost({ hidden: true });
  await nextTick();
  assert.equal(live.size, 0);
  selectRoom(state, "room-b");
  await nextTick();
  state.showCompanyHome = false;
  await nextTick();
  assert.deepEqual([...live], ["room-b#1"]);
  assert.equal(countOf(events, "mounted"), 1);

  await switchRoom(state, "room-c");
  assert.deepEqual([...live], ["room-c#2"]);
  assert.deepEqual(errors, []);
  app.unmount();
});

test("unmounting the app while the room is hidden (sign-out) unmounts the hidden shell", async () => {
  const { app, state, live, errors } = mountRoomShellHost();
  await nextTick();
  state.selectedSnapshotLoading = true;
  await nextTick();
  state.showCompanyHome = true;
  await nextTick();
  selectRoom(state, "room-b");
  await nextTick();
  app.unmount();
  assert.equal(live.size, 0);
  assert.deepEqual(errors, []);
});

test("useKeyWhileShown follows the key only while shown", () => {
  const shown = ref(true);
  const key = ref("a");
  const kept = useKeyWhileShown(shown, key);
  assert.equal(kept.value, "a");
  shown.value = false;
  key.value = "x";
  assert.equal(kept.value, "a", "a hidden change is ignored");
  key.value = "a";
  assert.equal(kept.value, "a");
  key.value = "b";
  shown.value = true;
  assert.equal(kept.value, "b", "on show the current key is taken at once");
  key.value = "c";
  assert.equal(kept.value, "c", "while shown the key follows");

  const hiddenAtStart = useKeyWhileShown(ref(false), ref("first"));
  assert.equal(hiddenAtStart.value, "first", "a hidden start keeps the initial key");
});
