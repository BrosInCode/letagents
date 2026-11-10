import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { compile } from "@vue/compiler-dom";
import { parse } from "@vue/compiler-sfc";
import * as Vue from "vue";
import { createRenderer, defineComponent, getCurrentInstance, h, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, reactive } from "vue";

// App.vue keeps the open room shell in a KeepAlive so that hiding the room
// (Settings, Inbox, company home) and showing the same room again keeps scroll
// position and composer state. A room switch must still unmount the old shell.
// Vue 3.5's KeepAlive with `max: 1` and a keyed child loses the old child when
// the parent re-renders with the same key before the key changes: the pruned
// entry is the current one, Vue resets the flag on a clone of the mounted
// vnode, and the mounted subtree is deactivated instead of unmounted. Nothing
// unmounts it later, so every switch kept a whole room alive.

const appSource = readFileSync(fileURLToPath(new URL("../src/App.vue", import.meta.url)), "utf8");

function roomShellKeepAliveTemplate(): string {
  const template = parse(appSource).descriptor.template!.content;
  const blocks = template.match(/<KeepAlive\b[\s\S]*?<\/KeepAlive>/g) ?? [];
  assert.equal(blocks.length, 1, "App.vue has one KeepAlive block");
  assert.match(blocks[0]!, /<DesktopRoomShell\b/, "the KeepAlive block holds the room shell");
  return blocks[0]!;
}

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

function mountRoomShellHost() {
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
    showCompanyHome: false,
    activeEntry: { type: "room", id: "room-a" },
    selectedNeedsAccess: false,
    selectedRoomRenderKey: "room-a",
    selectedRoomInfo: { identifier: "room-a", displayName: "", name: "room-a" },
    selectedSnapshotLoading: false,
    roomSettingsSectionRequestFor: () => null,
    chatScrollPositionForRoom: () => null,
  });
  const Host = defineComponent({ components: { DesktopRoomShell }, setup: () => state, render });

  const app = renderer.createApp(Host);
  const errors: string[] = [];
  app.config.errorHandler = (error) => { errors.push(error instanceof Error ? error.message : String(error)); };
  app.config.warnHandler = () => {};
  const root = fakeNode("root");
  app.mount(root);
  return { app, state, events, live, errors };
}

async function switchRoom(state: ReturnType<typeof mountRoomShellHost>["state"], room: string) {
  // The app re-renders the shell's parent while the same room stays open (a
  // snapshot load flag, a new message), and only then the room changes.
  state.selectedSnapshotLoading = !state.selectedSnapshotLoading;
  await nextTick();
  state.selectedRoomRenderKey = room;
  state.selectedRoomInfo = { identifier: room, displayName: "", name: room };
  await nextTick();
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
  assert.equal(events.filter((entry) => entry.event === "mounted").length, 1, "the room is not mounted again");
  assert.equal(events.filter((entry) => entry.event === "unmounted").length, 0);

  // A room change while the room view is hidden must not keep the old shell either.
  state.showCompanyHome = true;
  await nextTick();
  state.selectedRoomRenderKey = "room-b";
  await nextTick();
  state.showCompanyHome = false;
  await nextTick();
  assert.deepEqual([...live], ["room-b#2"], "the room hidden before the change is unmounted");
  assert.deepEqual(errors, []);
  app.unmount();
});
