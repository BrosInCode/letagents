import "../../../../shared/room-unread.test.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { parse } from "@vue/compiler-sfc";
import ts from "typescript";
import { createServer } from "vite";
import { createRenderer, h, reactive, ref, ssrContextKey } from "vue";
import { createRoomUnreadStore } from "../../../../shared/room-unread.mjs";
import { markRoomRead, roomReadKey, roomReadMarkerKey } from "../src/domain/desktop-room-read-state";

test("per-room storage controls refresh the unread history namespace, including a local fork", async () => {
  async function functionsFrom(path: string, names: string[]): Promise<string> {
    const { descriptor } = parse(await readFile(new URL(path, import.meta.url), "utf8"));
    const script = ts.createSourceFile("component.ts", descriptor.scriptSetup!.content, ts.ScriptTarget.Latest, true);
    return ts.transpileModule(script.statements.filter(statement =>
      ts.isFunctionDeclaration(statement) && names.includes(statement.name?.text || ""),
    ).map(statement => statement.getText(script)).join("\n"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
  }
  const appCode = await functionsFrom("../src/App.vue", ["handleRoomShellRefresh", "roomHistoryMode", "roomUsesLocalHistory", "loadChatStorageSettings"]);
  const shellCode = await functionsFrom("../src/components/desktop/content/DesktopRoomShell.vue", ["setRoomStorageMode", "forkRoomToLocal"]);
  const roomIdentifier = "github.com/acme/repo";
  const chatStorageSettings = ref({ mode: "cloud", roomOverrides: {} as Record<string, string> });
  const sidebarLatestMessages = ref<Record<string, any>>({ [roomIdentifier]: { storageMode: "cloud", latestMessageId: "msg_900" } });
  let persistedMode = "cloud", settingsReads = 0, refreshes = 0;
  let pendingRefresh: Promise<void> | undefined;
  const snapshot = () => ({ roomIdentifier, storage: { effectiveMode: persistedMode } });
  const bridge = {
    getSettings: async () => { settingsReads++; return { mode: "cloud", roomOverrides: { [roomIdentifier]: persistedMode } }; },
    setRoomMode: async (_room: string, mode: string) => { persistedMode = mode; },
    forkRoomToLocal: async () => { persistedMode = "local"; return { snapshot: snapshot() }; },
  };
  const app = runInNewContext(appCode + "\n({ handleRoomShellRefresh, roomHistoryMode })", {
    roomReadKey, chatStorageSettings, sidebarLatestMessages,
    accountRooms: ref([{ roomIdentifier, source: "cloud", focusRooms: [] }]),
    sessionGeneration: ref(1), getChatStorageBridge: () => bridge,
    chatStorageFeedback: ref(null), handleRefreshRoom() {}, syncSelectedRoomStream() {},
    refreshSidebarLatestMessages: async () => {
      refreshes++;
      assert.equal(app.roomHistoryMode(roomIdentifier), persistedMode, "discard metadata from the previous history before refreshing");
      sidebarLatestMessages.value = { [roomIdentifier]: { storageMode: persistedMode, latestMessageId: persistedMode === "local" ? "msg_4" : "msg_900" } };
    },
  });
  const props = { room: { identifier: roomIdentifier }, storage: { localRoom: {} as object | null } };
  const setMode = runInNewContext(shellCode + "\nsetRoomStorageMode", {
    props, storageBusy: ref(false), actionPanelOpen: ref(true), window: { confirm: () => true },
    desktopIpc: { chatStorage: bridge, room: { getSnapshot: async () => snapshot(), stopStream: async () => {} } },
    emit: (event: string, value: unknown) => { assert.equal(event, "refresh-room"); pendingRefresh = app.handleRoomShellRefresh(value); },
  });
  for (const mode of ["local", "cloud", "local"]) {
    if (refreshes === 2) props.storage.localRoom = null;
    await setMode(mode);
    await pendingRefresh;
    assert.equal(app.roomHistoryMode(roomIdentifier), mode);
    assert.equal(roomReadMarkerKey(roomIdentifier, app.roomHistoryMode(roomIdentifier)), mode === "local" ? `${roomIdentifier}::local-history` : roomIdentifier);
  }
  assert.equal(settingsReads, 3);
  assert.equal(refreshes, 3);
});

test("App's explicit sidebar read action clears its bookmark even when the old marker is already current", async () => {
  const source = await readFile(new URL("../src/App.vue", import.meta.url), "utf8");
  const { descriptor } = parse(source);
  const script = ts.createSourceFile("App.ts", descriptor.scriptSetup!.content, ts.ScriptTarget.Latest, true);
  const handler = script.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "markRoomEntryRead");
  assert.ok(handler);
  const code = ts.transpileModule(handler.getText(script), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  function readAction(node: any): string | undefined {
    const event = node.props?.find((prop: any) => prop.type === 7 && prop.name === "on" && prop.arg?.content === "mark-room-read");
    return event?.exp?.content ?? node.children?.map(readAction).find(Boolean);
  }
  const expression = readAction(descriptor.template!.ast);
  assert.ok(expression, "exercise the sidebar event wired by App.vue");
  const data = new Map<string, string>();
  const store = createRoomUnreadStore({ namespace: "read-action", storage: () => ({
    getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); },
  }) });
  store.mark("alice", "room", "msg_5");
  store.mark("alice", "other", "msg_6");
  store.mark("bob", "room", "msg_7");
  const readRoomMessageIds = ref({ room: "msg_9" });
  let writes = 0;
  const context = {
    readRoomMessageIds, markRoomRead, roomReadMarkerKey, roomHistoryMode: () => "cloud",
    latestMessageIdForEntry: () => "msg_9",
    rememberRoomMessageIds: () => { writes++; },
    roomUnread: { get: (room: string) => store.get("alice", room), clear: (room: string, revision: string) => store.clear("alice", room, revision) },
  };
  const automatic = runInNewContext(code + "\nmarkRoomEntryRead", context);
  automatic({ roomIdentifier: "room" });
  assert.ok(store.get("alice", "room"), "selection and automatic read updates preserve the bookmark");
  const explicit = runInNewContext(code + "\n(" + expression + ")", context);
  explicit({ roomIdentifier: "room" });
  assert.equal(store.get("alice", "room"), null);
  assert.equal(store.get("alice", "other")?.messageId, "msg_6");
  assert.equal(store.get("bob", "room")?.messageId, "msg_7");
  assert.equal(readRoomMessageIds.value.room, "msg_9");
  assert.equal(writes, 0, "no redundant write to the old marker map");
  const batchHandler = script.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "handleSidebarBatchAction");
  assert.ok(batchHandler);
  const batchCode = ts.transpileModule(batchHandler.getText(script), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const batch = runInNewContext(code + "\n" + batchCode + "\nhandleSidebarBatchAction", {
    ...context, sidebarBatchActionBusy: ref(false), sidebarSelectedEntries: ref([]), currentParentRoom: ref({ id: "room" }),
    resolveSidebarRoomBatchAction: () => ({ targets: [{ roomIdentifier: "other" }] }), pushActionToast() {},
  });
  await batch("mark-read");
  assert.equal(store.get("alice", "other"), null, "batch Mark as read also clears the explicit bookmark");
  assert.equal(store.get("bob", "room")?.messageId, "msg_7");
});

test("desktop message action is confined to the main timeline and writes only its local bookmark", async () => {
  const vite = await createServer({ root: fileURLToPath(new URL("../..", import.meta.url)), appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  let Message: any, unreadMenuKey: any;
  try {
    Message = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/DesktopChatMessage.vue")).default;
    ({ unreadMenuKey } = await vite.ssrLoadModule(fileURLToPath(new URL("../../../../shared/room-unread-client.ts", import.meta.url))));
  } finally { await vite.close(); }
  const oldWindow = globalThis.window;
  Object.assign(globalThis, { window: new EventTarget() });
  const props = reactive({
    message: { id: "msg_9", sender: "Ada", source: "browser", text: "Read later", timestamp: "2026-10-02T00:00:00Z", attachments: [], agentIdentity: null, threadRootId: "msg_9", threadReplyToId: null as string | null },
    context: "timeline", threadSummary: { count: 0, unreadCount: 0, participants: [] }, highlightQuery: "",
  });
  const before = JSON.stringify(props.message), marks: any[] = [], emitted: any[] = [];
  let vm: any;
  const renderer = createRenderer<any, any>({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null });
  const app = renderer.createApp({ setup() {
    vm = Message.setup(props, { expose() {}, emit: (...args: any[]) => emitted.push(args) });
    return () => h("div");
  } });
  app.provide(ssrContextKey, { modules: new Set() });
  app.provide(unreadMenuKey, { client: { account: ref("alice"), mark: (...args: any[]) => marks.push(args) }, room: ref("room") });
  try {
    app.mount({});
    assert.equal(vm.canMarkUnread.value, true);
    vm.markUnreadFromContext();
    assert.deepEqual(marks, [["room", "msg_9"]]);
    assert.deepEqual(emitted, []);
    assert.equal(JSON.stringify(props.message), before);
    for (const context of ["thread-root", "thread-reply"]) {
      props.context = context;
      assert.equal(vm.canMarkUnread.value, false);
      vm.markUnreadFromContext();
    }
    assert.equal(marks.length, 1);
    props.context = "timeline"; props.message.threadRootId = "msg_1";
    assert.equal(vm.canMarkUnread.value, false);
    props.message.threadRootId = "msg_9"; props.message.id = "pending:1";
    assert.equal(vm.canMarkUnread.value, false);
  } finally { app.unmount(); Object.assign(globalThis, { window: oldWindow }); }
});
