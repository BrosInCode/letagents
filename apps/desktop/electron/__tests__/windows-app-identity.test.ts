import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  WINDOWS_APP_USER_MODEL_ID,
  applyWindowsAppUserModelId,
  showWindowsSmokeNotification,
} from "../main/windows-app-identity.js";

function fakeApp(isPackaged: boolean) {
  const ids: string[] = [];
  return { ids, app: { isPackaged, setAppUserModelId: (id: string) => { ids.push(id); } } };
}

test("the installed Windows app takes the installer's AppUserModelID", () => {
  const { ids, app } = fakeApp(true);
  assert.equal(applyWindowsAppUserModelId(app, "win32", "C:\\LetAgents\\LetAgents.exe"), WINDOWS_APP_USER_MODEL_ID);
  assert.deepEqual(ids, ["chat.letagents.desktop"]);
});

test("an unpackaged Windows run uses its own executable, as no shortcut has the release ID", () => {
  const { ids, app } = fakeApp(false);
  assert.equal(applyWindowsAppUserModelId(app, "win32", "C:\\repo\\electron.exe"), "C:\\repo\\electron.exe");
  assert.deepEqual(ids, ["C:\\repo\\electron.exe"]);
});

test("macOS and Linux never set an AppUserModelID", () => {
  for (const platform of ["darwin", "linux"] as const) {
    const { ids, app } = fakeApp(true);
    assert.equal(applyWindowsAppUserModelId(app, platform), null);
    assert.deepEqual(ids, []);
  }
});

function fakeNotificationClass(behaviour: "show" | "failed" | "silent" | "throw") {
  return class extends EventEmitter {
    constructor(readonly options: unknown) { super(); if (behaviour === "throw") throw new Error("no toasts"); }
    show() {
      if (behaviour === "show") setImmediate(() => this.emit("show"));
      if (behaviour === "failed") setImmediate(() => this.emit("failed", {}, "Notifications are disabled"));
    }
  } as never;
}

test("the smoke notification reports what Windows did with it and never throws", async () => {
  for (const [behaviour, expected, logged] of [
    ["show", "shown", "LETAGENTS_DESKTOP_SMOKE_NOTIFICATION shown"],
    ["failed", "failed", "LETAGENTS_DESKTOP_SMOKE_NOTIFICATION failed Notifications are disabled"],
    ["silent", "timeout", "LETAGENTS_DESKTOP_SMOKE_NOTIFICATION timeout"],
    ["throw", "failed", "LETAGENTS_DESKTOP_SMOKE_NOTIFICATION failed no toasts"],
  ] as const) {
    const lines: string[] = [];
    assert.equal(await showWindowsSmokeNotification(fakeNotificationClass(behaviour), (line) => lines.push(line), 20), expected);
    assert.deepEqual(lines, [logged]);
  }
});
