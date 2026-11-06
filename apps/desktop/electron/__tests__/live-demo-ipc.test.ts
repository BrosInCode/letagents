import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { createElectronTestEnv } from "./harness.js";

const env = createElectronTestEnv({ prefix: "live-demo-ipc-" });
env.resetState({});

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const handlers = new Map<string, Handler>();
const fakeIpcMain = {
  handle(channel: string, handler: Handler) { handlers.set(channel, handler); },
  on() {},
  removeHandler() {},
};
mock.module("electron", { defaultExport: { ipcMain: fakeIpcMain }, namedExports: { ipcMain: fakeIpcMain } });

const calls: Array<[string, ...unknown[]]> = [];
const record = (name: string, result?: unknown) => (...args: unknown[]) => {
  calls.push([name, ...args]);
  return result;
};
mock.module("../main/rooms/live-demo.js", { namedExports: {
  LIVE_DEMO_EVENT_CHANNEL: "desktop:room:live-demo-event",
  joinLiveDemo: record("join"),
  leaveLiveDemo: record("leave"),
  sendLiveDemoFrame: record("send"),
  watchLiveDemoOwner: record("watch-owner"),
  reconnectLiveDemos: record("reconnect"),
} });
mock.module("../main/rooms/demo-marks.js", { namedExports: {
  listDesktopDemoMarks: async (...args: unknown[]) => record("list-marks", ["mark"])(...args),
  addDesktopDemoMark: async (...args: unknown[]) => record("add-mark", { id: "mark_00001" })(...args),
  removeDesktopDemoMark: async (...args: unknown[]) => { record("remove-mark")(...args); },
} });
mock.module("../main/attachments/demo-markup.js", { namedExports: {
  captureDesktopDemoMarkup: async (...args: unknown[]) => record("capture", { uploadId: "upload_1" })(...args),
} });

const mainContents = { id: 1 };
const mainWindow = { webContents: mainContents, isDestroyed: () => false };
let currentMainWindow: typeof mainWindow | null = mainWindow;
mock.module("../main/window.js", { namedExports: {
  ...await import("../main/window.js"),
  getMainWindow: () => currentMainWindow,
} });

const { registerDesktopRoomIpcHandlers } = await import("../main/ipc-handlers/rooms.js");
registerDesktopRoomIpcHandlers(fakeIpcMain as never);

const ROOM = "github.com/BrosInCode/letagents";
const LIVE_CHANNELS: Array<[string, unknown[]]> = [
  ["desktop:room:live-demo-join", [ROOM, "msg_1/att_1", "letagents-demo://lease/"]],
  ["desktop:room:live-demo-leave", [ROOM, "msg_1/att_1"]],
  ["desktop:room:live-demo-send", [ROOM, { t: "cur", demo: "msg_1/att_1", x: 1, y: 2 }]],
  ["desktop:room:list-demo-marks", [ROOM, "msg_1/att_1"]],
  ["desktop:room:add-demo-mark", [ROOM, { demo: "msg_1/att_1", kind: "pin", at: [1, 2], text: "Here", anchor: null }]],
  ["desktop:room:remove-demo-mark", [ROOM, "mark_00001"]],
  ["desktop:room:set-inline-demo-width", ["letagents-demo://00000000000000000000000000000000/", 380]],
  ["desktop:room:capture-demo-markup", [ROOM, { x: 0, y: 0, width: 10, height: 10 }, "demo.png"]],
];

test("every live demo channel answers only the main window", async () => {
  for (const [channel, args] of LIVE_CHANNELS) {
    const handler = handlers.get(channel);
    assert.ok(handler, `${channel} is registered`);
    await assert.rejects(handler({ sender: { id: 2 } }, ...args), /main window/, `${channel} refuses another sender`);
    currentMainWindow = null;
    await assert.rejects(handler({ sender: mainContents }, ...args), /main window/, `${channel} refuses with no main window`);
    currentMainWindow = mainWindow;
  }
  assert.deepEqual(calls, []);
});

test("live demo channels pass the chat's arguments through", async () => {
  const run = (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender: mainContents }, ...args);
  calls.length = 0;
  for (const [channel, args] of LIVE_CHANNELS) {
    if (channel === "desktop:room:set-inline-demo-width") {
      await assert.rejects(run(channel, ...args), /closed/, "an unknown lease is a closed demo");
      continue;
    }
    await run(channel, ...args);
  }
  assert.deepEqual(calls, [
    ["watch-owner", mainContents],
    ["join", ...LIVE_CHANNELS[0]![1]],
    ["leave", ...LIVE_CHANNELS[1]![1]],
    ["send", ...LIVE_CHANNELS[2]![1]],
    ["list-marks", ...LIVE_CHANNELS[3]![1]],
    ["add-mark", ...LIVE_CHANNELS[4]![1]],
    ["remove-mark", ...LIVE_CHANNELS[5]![1]],
    ["capture", mainWindow, ...LIVE_CHANNELS[7]![1]],
  ]);
  assert.deepEqual(await run("desktop:room:list-demo-marks", ROOM, "msg_1/att_1"), ["mark"]);
  assert.deepEqual(await run("desktop:room:capture-demo-markup", ROOM, {}, "x"), { uploadId: "upload_1" });
  assert.equal(await run("desktop:room:remove-demo-mark", ROOM, "mark_00001"), undefined);
});
