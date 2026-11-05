import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test, { mock } from "node:test";

const { stagedAttachment } = await import("../main/attachments/store.js");

const staged: Array<{ room: string; file: { fileName: string; mimeType: string; bytes: Buffer } }> = [];
// The real stores stage through stagedAttachment, which gives an image its preview.
mock.module("../main/attachments.js", { namedExports: {
  resolveAttachmentStore: async (room: string) => ({
    kind: "cloud",
    roomIdentifier: room,
    stage: async (file: { fileName: string; mimeType: string; bytes: Buffer }) => {
      staged.push({ room, file });
      return stagedAttachment(file, "upload_1");
    },
    discard: async () => {},
  }),
} });

const apiCalls: unknown[][] = [];
let apiAnswer: unknown = undefined;
let storageMode: "cloud" | "local" = "cloud";
mock.module("../main/auth.js", { namedExports: {
  apiFetch: async (...args: unknown[]) => {
    apiCalls.push(args);
    return apiAnswer;
  },
} });
mock.module("../main/rooms/local-store.js", { namedExports: {
  resolveLocalAwareRoomStorageMode: async () => ({ effectiveMode: storageMode }),
  cloudRoomIdentifierForStorage: (_storage: unknown, room: string) => `${room.trim()}`,
} });

const { captureDesktopDemoMarkup, demoMarkupCaptureRect, demoMarkupFileName, DEMO_MARKUP_MAX_SIDE } = await import("../main/attachments/demo-markup.js");
const { addDesktopDemoMark, listDesktopDemoMarks, removeDesktopDemoMark } = await import("../main/rooms/demo-marks.js");

const ROOM = "github.com/BrosInCode/letagents";
const DEMO = "msg_1/att_1";
const mark = (id: string, demo = DEMO) => ({
  id, demo, kind: "pin", at: [10, 20], text: "Here", anchor: null, createdAt: "2026-11-05T00:00:00.000Z",
  author: { accountId: "acct_1", name: "Ada", color: "#e5484d" },
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function fakeImage(width: number, height: number, resized: unknown[] = []) {
  return {
    isEmpty: () => width === 0 || height === 0,
    getSize: () => ({ width, height }),
    resize(options: { width?: number; height?: number }) {
      resized.push(options);
      const next = options.width
        ? fakeImage(options.width, Math.round((height * options.width) / width), resized)
        : fakeImage(Math.round((width * options.height!) / height), options.height!, resized);
      return next;
    },
    toPNG: () => PNG,
  };
}

function fakeWindow(options: { zoom?: number; size?: [number, number]; scale?: number; empty?: boolean } = {}) {
  const captures: unknown[] = [];
  const resized: unknown[] = [];
  const scale = options.scale ?? 2;
  return {
    captures,
    resized,
    window: {
      isDestroyed: () => false,
      getContentSize: () => options.size ?? [1200, 800],
      webContents: {
        getZoomFactor: () => options.zoom ?? 1,
        capturePage: async (rect: { width: number; height: number }) => {
          captures.push(rect);
          return options.empty ? fakeImage(0, 0) : fakeImage(rect.width * scale, rect.height * scale, resized);
        },
      },
    },
  };
}

test("the capture rectangle is the chat's CSS px times the app's zoom, cut to the window", () => {
  const size = { width: 1200, height: 800 };
  assert.deepEqual(demoMarkupCaptureRect({ x: 100, y: 50, width: 400, height: 300 }, 1, size), { x: 100, y: 50, width: 400, height: 300 });
  // Measured in Electron 42: at app zoom 1.25, capturePage takes window points, not CSS px.
  assert.deepEqual(demoMarkupCaptureRect({ x: 100.4, y: 50, width: 400, height: 300 }, 1.25, size), { x: 125, y: 62, width: 501, height: 376 });
  assert.deepEqual(demoMarkupCaptureRect({ x: -50, y: 600, width: 2000, height: 500 }, 1.25, size), { x: 0, y: 750, width: 1200, height: 50 });
  assert.equal(demoMarkupCaptureRect({ x: 0, y: 900, width: 100, height: 100 }, 1, size), null, "below the window");
  assert.equal(demoMarkupCaptureRect({ x: 10, y: 10, width: 0, height: 100 }, 1, size), null);
  assert.equal(demoMarkupCaptureRect({ x: 10, y: 10, width: 100, height: -5 }, 1, size), null, "a card scrolled out of sight");
  assert.equal(demoMarkupCaptureRect({ x: 10, y: 10, width: -0.5, height: 100 }, 1, size), null);
  assert.equal(demoMarkupCaptureRect({ x: 10, y: 10, width: Number.NaN, height: 100 }, 1, size), null);
  assert.equal(demoMarkupCaptureRect({ x: "10", y: 10, width: 10, height: 100 }, 1, size), null);
  assert.equal(demoMarkupCaptureRect(null, 1, size), null);
});

test("a capture's file name is a plain PNG name", () => {
  assert.equal(demoMarkupFileName("Demo marks"), "Demo marks.png");
  assert.equal(demoMarkupFileName("Demo marks.PNG"), "Demo marks.png");
  assert.equal(demoMarkupFileName("../../etc/passwd"), "-..-etc-passwd.png");
  assert.equal(demoMarkupFileName("‮gnp.exe"), "gnp.exe.png");
  assert.equal(demoMarkupFileName("   "), "demo-marks.png");
  assert.equal(demoMarkupFileName(42), "demo-marks.png");
  assert.equal(demoMarkupFileName("x".repeat(300)).length, 124);
});

test("a capture of the demo is staged in the room as a PNG, as a picked image is", async () => {
  staged.length = 0;
  const { window, captures } = fakeWindow({ zoom: 1.25 });
  const attachment = await captureDesktopDemoMarkup(window as never, ROOM, { x: 10, y: 20, width: 380, height: 300 }, "Checkout demo");
  // Rounded outward, so the whole card is in the picture.
  assert.deepEqual(captures, [{ x: 12, y: 25, width: 476, height: 375 }]);
  assert.equal(staged.length, 1);
  assert.equal(staged[0]!.room, ROOM);
  assert.deepEqual(staged[0]!.file, { fileName: "Checkout demo.png", mimeType: "image/png", bytes: PNG });
  assert.equal(attachment.uploadId, "upload_1");
  assert.equal(attachment.previewDataUrl, `data:image/png;base64,${PNG.toString("base64")}`, "the chat shows it before posting");
});

test("a large capture is scaled down, and an empty or off-screen one is refused", async () => {
  staged.length = 0;
  const wide = fakeWindow({ size: [3000, 1000], scale: 2 });
  await captureDesktopDemoMarkup(wide.window as never, ROOM, { x: 0, y: 0, width: 3000, height: 1000 }, "wide");
  assert.deepEqual(wide.resized, [{ width: DEMO_MARKUP_MAX_SIDE, quality: "good" }]);
  const tall = fakeWindow({ size: [1000, 3000], scale: 1 });
  await captureDesktopDemoMarkup(tall.window as never, ROOM, { x: 0, y: 0, width: 500, height: 3000 }, "tall");
  assert.deepEqual(tall.resized, [{ height: DEMO_MARKUP_MAX_SIDE, quality: "good" }]);
  const small = fakeWindow();
  await captureDesktopDemoMarkup(small.window as never, ROOM, { x: 0, y: 0, width: 300, height: 200 }, "small");
  assert.deepEqual(small.resized, []);

  await assert.rejects(captureDesktopDemoMarkup(fakeWindow({ empty: true }).window as never, ROOM, { x: 0, y: 0, width: 10, height: 10 }, "x"), /could not be captured/);
  await assert.rejects(captureDesktopDemoMarkup(fakeWindow().window as never, ROOM, { x: 0, y: 900, width: 10, height: 10 }, "x"), /not on screen/);
  await assert.rejects(captureDesktopDemoMarkup(fakeWindow().window as never, " ", { x: 0, y: 0, width: 10, height: 10 }, "x"), /room/);
  assert.equal(staged.length, 3);
});

test("marks are read and written through the app's own sign-in, and checked both ways", async () => {
  apiCalls.length = 0;
  storageMode = "cloud";
  apiAnswer = { marks: [mark("mark_00001"), mark("bad"), mark("mark_00002", "msg_9/att_9"), { id: "mark_00003" }] };
  assert.deepEqual(await listDesktopDemoMarks(ROOM, DEMO), [mark("mark_00001")], "unreadable marks and other demos' marks are left out");
  assert.deepEqual(apiCalls.at(-1), [
    "/rooms/github.com%2FBrosInCode%2Fletagents/demo-marks?demo=msg_1%2Fatt_1", undefined, { credential: "app" },
  ]);
  apiAnswer = { nothing: true };
  assert.deepEqual(await listDesktopDemoMarks(ROOM, DEMO), []);
  await assert.rejects(listDesktopDemoMarks(ROOM, "msg_1"), /cannot hold marks/);

  const input = { demo: DEMO, kind: "stroke", points: [[1, 2], [3, 4]], anchor: null };
  apiAnswer = { mark: { ...mark("mark_00004"), kind: "stroke", points: [[1, 2], [3, 4]] } };
  assert.equal((await addDesktopDemoMark(ROOM, input)).id, "mark_00004");
  assert.deepEqual(apiCalls.at(-1), [
    "/rooms/github.com%2FBrosInCode%2Fletagents/demo-marks", { method: "POST", body: JSON.stringify(input) }, { credential: "app" },
  ]);
  const before = apiCalls.length;
  await assert.rejects(addDesktopDemoMark(ROOM, { ...input, points: [[1, 2]] }), /cannot be saved/, "a stroke needs two points");
  await assert.rejects(addDesktopDemoMark(ROOM, { ...input, extra: true }), /cannot be saved/);
  assert.equal(apiCalls.length, before, "an invalid mark never reaches the server");
  apiAnswer = { mark: mark("mark_00005", "msg_9/att_9") };
  await assert.rejects(addDesktopDemoMark(ROOM, input), /could not read it back/);

  apiAnswer = undefined;
  await removeDesktopDemoMark(ROOM, "mark_00004");
  assert.deepEqual(apiCalls.at(-1), [
    "/rooms/github.com%2FBrosInCode%2Fletagents/demo-marks/mark_00004", { method: "DELETE" }, { credential: "app" },
  ]);
  await assert.rejects(removeDesktopDemoMark(ROOM, "../x"), /cannot be removed/);

  storageMode = "local";
  const count = apiCalls.length;
  assert.deepEqual(await listDesktopDemoMarks("local_room", DEMO), [], "a room on this computer has no saved marks");
  await assert.rejects(addDesktopDemoMark("local_room", input), /server/);
  await assert.rejects(removeDesktopDemoMark("local_room", "mark_00004"), /server/);
  assert.equal(apiCalls.length, count);
  storageMode = "cloud";
});
