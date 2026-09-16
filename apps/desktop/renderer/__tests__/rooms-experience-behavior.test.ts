import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createRenderer, h, nextTick, reactive, ssrContextKey } from "vue";
import { createServer, type ViteDevServer } from "vite";

let vite: ViteDevServer;
let RoomDetails: any, Directory: any;
const originalWindow = globalThis.window;
const settings = {
  parent_visibility: "summary_only",
  activity_scope: "task_and_branch",
  github_event_routing: "task_and_branch",
};
const room = (id = "focus_1") => ({
  roomId: id,
  identifier: id,
  displayName: "Focus: Release planning",
  kind: "focus",
  focusStatus: "active",
  parentRoomId: "main",
  focusKey: "topic_release",
  focusSettings: { ...settings },
  sourceTaskId: null,
  gitRoom: null,
  createdAt: "2026-09-16T10:00:00Z",
  concludedAt: null,
  conclusionSummary: null,
});
const renderer = createRenderer<any, any>({
  patchProp() {},
  insert(child, parent) {
    parent.children.push(child);
    child.parent = parent;
  },
  remove() {},
  createElement: () => ({ children: [] }),
  createText: () => ({ children: [] }),
  createComment: () => ({ children: [] }),
  setText() {},
  setElementText() {},
  parentNode: (node) => node.parent,
  nextSibling: () => null,
});
function mountSetup(component: any, props: any) {
  let vm: any;
  const events: any[] = [];
  const app = renderer.createApp({
    setup() {
      vm = component.setup(props, {
        expose() {},
        emit: (...args: any[]) => events.push(args),
      });
      return () => h("div");
    },
  });
  app.provide(ssrContextKey, { modules: new Set<string>() });
  app.mount({ children: [] });
  return { vm, events, stop: () => app.unmount() };
}
function desktopProps() {
  return reactive({
    room: {
      identifier: "main",
      displayName: "Main room",
      kind: "main",
      role: "admin",
    },
    focusRooms: [room()],
    tasks: [{ id: "task_1", title: "Ship release", status: "in_progress" }],
  } as any);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
function bridge(methods: Record<string, unknown>) {
  Object.assign(globalThis, {
    window: { setTimeout, clearTimeout, letagentsDesktop: { room: methods } },
  });
}
before(async () => {
  bridge({});
  vite = await createServer({
    root: fileURLToPath(new URL("../..", import.meta.url)),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  RoomDetails = (
    await vite.ssrLoadModule(
      "/renderer/src/components/desktop/content/RoomDetailsView.vue",
    )
  ).default;
  Directory = (
    await vite.ssrLoadModule(
      "/@fs/" +
        fileURLToPath(
          new URL(
            "../../../../shared/rooms/RoomsDirectory.vue",
            import.meta.url,
          ),
        ),
    )
  ).default;
});
after(async () => {
  Object.assign(globalThis, { window: originalWindow });
  await vite?.close();
});

test("desktop creation enters the returned room before its refresh snapshot and ignores duplicate submits", async () => {
  const result = deferred<any>();
  let creates = 0;
  bridge({
    createAdHocFocusRoom: () => {
      creates++;
      return result.promise;
    },
  });
  const props = desktopProps();
  props.focusRooms = [];
  const mounted = mountSetup(RoomDetails, props);
  const pending = mounted.vm.createAdHocFocusRoom("Release planning");
  await mounted.vm.createAdHocFocusRoom("Release planning");
  assert.equal(creates, 1);
  result.resolve({ focusRoom: room("focus_new") });
  await pending;
  assert.deepEqual(mounted.events, [
    ["refresh-room"],
    ["open-focus-room", "focus_new"],
  ]);
  await mounted.vm.createAdHocFocusRoom("Release planning");
  assert.equal(creates, 1, "opening again must not create a duplicate");
  assert.deepEqual(mounted.events.at(-1), ["open-focus-room", "focus_new"]);
  mounted.stop();
});

test("desktop settings drafts survive refreshes and a completed save does not select a different room", async () => {
  const result = deferred<any>();
  bridge({ updateFocusRoomSettings: () => result.promise });
  const props = desktopProps();
  props.focusRooms.push({ ...room("focus_2"), focusKey: "topic_other" });
  const mounted = mountSetup(RoomDetails, props);
  mounted.vm.selectedFocusRoomId.value = "focus_1";
  await nextTick();
  mounted.vm.settingsDraft.parent_visibility = "silent";
  props.focusRooms = props.focusRooms.map((item: any) => ({
    ...item,
    focusSettings: { ...item.focusSettings },
  }));
  await nextTick();
  assert.equal(mounted.vm.settingsDraft.parent_visibility, "silent");
  const pending = mounted.vm.saveSettings();
  mounted.vm.selectedFocusRoomId.value = "focus_2";
  await nextTick();
  result.resolve({ focusRoom: room("focus_1") });
  await pending;
  assert.equal(mounted.vm.selectedFocusRoomId.value, "focus_2");
  assert.equal(mounted.vm.settingsDraft.parent_visibility, "summary_only");
  mounted.stop();
});

test("desktop failed creation retains an actionable error and late success does not steal navigation", async () => {
  bridge({
    createAdHocFocusRoom: async () => {
      throw new Error("Offline");
    },
  });
  const props = desktopProps();
  const mounted = mountSetup(RoomDetails, props);
  await mounted.vm.createAdHocFocusRoom("Release planning");
  assert.ok(mounted.vm.creationError.value);
  assert.equal(mounted.vm.creatingAdHoc.value, false);
  const result = deferred<any>();
  bridge({ createAdHocFocusRoom: () => result.promise });
  const pending = mounted.vm.createAdHocFocusRoom("Release planning");
  props.room = { identifier: "another", kind: "main", displayName: "Another" };
  await nextTick();
  result.resolve({ focusRoom: room() });
  await pending;
  assert.deepEqual(mounted.events, []);
  mounted.stop();
});

test("shared directory keeps empty Open selected and opens an existing task room without creation", async () => {
  const props = reactive({
    rooms: [
      {
        id: "closed",
        title: "Done",
        kind: "task",
        closed: true,
        description: "",
        createdAt: null,
        closedAt: null,
      },
    ],
    tasks: [
      {
        id: "task_1",
        title: "Task",
        status: "in_progress",
        description: "",
        roomId: "closed",
        roomClosed: true,
      },
    ],
    parentLabel: "Main",
    busy: false,
  } as any);
  const mounted = mountSetup(Directory, props);
  assert.equal(mounted.vm.showClosed.value, false);
  assert.deepEqual(mounted.vm.visibleRooms.value, []);
  mounted.vm.selectedTaskId.value = "task_1";
  mounted.vm.createTask();
  assert.deepEqual(mounted.events, [["open", "closed"]]);
  mounted.vm.showClosed.value = true;
  mounted.vm.toggleDetails("closed");
  await nextTick();
  mounted.vm.query.value = "no match";
  await nextTick();
  assert.equal(mounted.vm.expandedId.value, null);
  assert.equal(
    mounted.vm.showClosed.value,
    true,
    "search must not switch filters",
  );
  props.busy = true;
  mounted.vm.topicTitle.value = "Duplicate";
  mounted.vm.createTopic();
  assert.equal(
    mounted.events.filter((e: any[]) => e[0] === "createTopic").length,
    0,
  );
  mounted.stop();
});

test("task search cannot create or open a selected task hidden by the query", () => {
  const props = reactive({
    rooms: [],
    tasks: [
      { id: "a", title: "Agent recovery", description: "", status: "open" },
      {
        id: "b",
        title: "Release planning",
        description: "",
        status: "open",
        roomId: "focus_b",
      },
    ],
    parentLabel: "Main",
    busy: false,
  } as any);
  const mounted = mountSetup(Directory, props);
  mounted.vm.selectedTaskId.value = "a";
  mounted.vm.taskQuery.value = "Release";
  assert.equal(mounted.vm.selectedTaskId.value, null);
  assert.equal(mounted.vm.selectedTask.value, undefined);
  mounted.vm.createTask();
  assert.deepEqual(mounted.events, []);
  mounted.vm.selectedTaskId.value = "b";
  mounted.vm.taskQuery.value = "No matching tasks";
  mounted.vm.createTask();
  assert.deepEqual(mounted.events, []);
  mounted.stop();
});

test("unmounting the desktop Rooms view prevents a late creation from navigating", async () => {
  const result = deferred<any>();
  bridge({ createAdHocFocusRoom: () => result.promise });
  const mounted = mountSetup(RoomDetails, desktopProps());
  const pending = mounted.vm.createAdHocFocusRoom("Release planning");
  mounted.stop();
  result.resolve({ focusRoom: room("focus_new") });
  await pending;
  assert.deepEqual(mounted.events, []);
});
