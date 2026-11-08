import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { buildDesktopRoomLink, parseDesktopRoomLink } from "../../../../shared/room-app-links.mjs";

// The main process module needs Electron's `app`; a small fake is enough to
// see which window event a link produces.
const appEvents = new Map<string, (...args: any[]) => void>();
const app = { isReady: () => true, isPackaged: false, setAsDefaultProtocolClient() {}, on(name: string, handler: (...args: any[]) => void) { appEvents.set(name, handler); }, quit() {}, requestSingleInstanceLock() { return true; } };
const autoUpdater = { on() {} };
const emitted: Array<[string, unknown]> = [];
mock.module("electron", { defaultExport: { app, autoUpdater }, namedExports: { app, autoUpdater } });
mock.module("../main/window.js", { namedExports: {
  createWindow() {}, focusMainWindow() {}, hasOpenWindows: () => true,
  emitToMainWindow(channel: string, payload: unknown) { emitted.push([channel, payload]); },
} });
const { desktopLinkFromArgv, parseDesktopLink, registerAskLinks } = await import("../main/ask-links.js");
const inbox = await import("../main/ask-link-inbox.js");

test("a room link mirrors the web path, with an optional message to reveal", () => {
  assert.equal(buildDesktopRoomLink("alerts-demo"), "letagents://in/alerts-demo");
  assert.equal(buildDesktopRoomLink("github.com/acme/app"), "letagents://in/github.com/acme/app");
  assert.equal(buildDesktopRoomLink("focus_12", "msg_42"), "letagents://in/focus_12?message=msg_42");
  assert.equal(buildDesktopRoomLink("alerts-demo", "nonsense"), "letagents://in/alerts-demo", "a bad message id is dropped, not sent");
  assert.equal(buildDesktopRoomLink("  "), "");
  assert.equal(buildDesktopRoomLink("a\u0000b"), "", "control characters never make a link");
  assert.equal(buildDesktopRoomLink("x".repeat(513)), "");
  assert.equal(buildDesktopRoomLink("room with space"), "letagents://in/room%20with%20space");
  assert.equal(buildDesktopRoomLink("local_42"), "", "a local room lives in one app's store: no link");
  assert.equal(buildDesktopRoomLink("git-room:local:acme/app"), "");
});

test("the app reads its own scheme and the web form, and refuses the rest", () => {
  assert.deepEqual(parseDesktopRoomLink("letagents://in/alerts-demo"), { roomIdentifier: "alerts-demo", messageId: null });
  assert.deepEqual(parseDesktopRoomLink("letagents://in/github.com/acme/app?message=msg_7"), { roomIdentifier: "github.com/acme/app", messageId: "msg_7" });
  assert.deepEqual(parseDesktopRoomLink("letagents://in/room%20with%20space"), { roomIdentifier: "room with space", messageId: null });
  assert.deepEqual(parseDesktopRoomLink("https://letagents.chat/in/alerts-demo?message=msg_3"), { roomIdentifier: "alerts-demo", messageId: "msg_3" });
  for (const url of [
    "letagents://in/", "letagents://in", "letagents://room/x", "letagents://ask/abcdefghijklmnopqrstuvwxyz012345",
    "https://evil.example/in/alerts-demo", "http://letagents.chat/in/x", "letagents://user:pw@in/x", "letagents://in:99/x",
    `letagents://in/${"x".repeat(513)}`, "letagents://in/a%00b", "nope", 42, null,
    "letagents://in/local_42", "letagents://in/Local-7", "letagents://in/git-room:local:acme/app", "https://letagents.chat/in/local_42",
  ]) {
    assert.equal(parseDesktopRoomLink(url as string), null, String(url));
  }
});

test("the main process tells ask links and room links apart, in open-url and in launch arguments", () => {
  const token = "abcdefghijklmnopqrstuvwxyz012345";
  assert.deepEqual(parseDesktopLink(`letagents://ask/${token}`), { kind: "ask", token });
  assert.deepEqual(parseDesktopLink("letagents://in/alerts-demo"), { kind: "room", room: { roomIdentifier: "alerts-demo", messageId: null } });
  assert.equal(parseDesktopLink("letagents://settings"), null);
  assert.deepEqual(desktopLinkFromArgv(["C:\\LetAgents\\LetAgents.exe", "--flag", "letagents://in/alerts-demo"]),
    { kind: "room", room: { roomIdentifier: "alerts-demo", messageId: null } });
  assert.equal(desktopLinkFromArgv(["/opt/LetAgents/letagents"]), null);
});

test("a room link reaches a loaded window at once, and waits for a window that is still loading", () => {
  registerAskLinks();
  const openUrl = appEvents.get("open-url")!;
  assert.ok(openUrl, "the handler is registered before ready");
  inbox.takePendingRoomLink();
  emitted.length = 0;
  openUrl({ preventDefault() {} }, "letagents://in/alerts-demo?message=msg_9");
  assert.deepEqual(emitted, [["desktop:room:open-link", { roomIdentifier: "alerts-demo", messageId: "msg_9" }]]);
  assert.equal(inbox.takePendingRoomLink(), null, "delivered links are not held");

  // The window is new: its renderer takes the link once it loads, and only that kind of link.
  inbox.askLinkRendererGone();
  emitted.length = 0;
  openUrl({ preventDefault() {} }, "letagents://in/design-lounge");
  assert.deepEqual(emitted, []);
  assert.equal(inbox.takePendingAskLink(), null, "an ask reader never takes a room link");
  assert.deepEqual(inbox.takePendingRoomLink(), { roomIdentifier: "design-lounge", messageId: null });
  assert.equal(inbox.takePendingRoomLink(), null);
});
