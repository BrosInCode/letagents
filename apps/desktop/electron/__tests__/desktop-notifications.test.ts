import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";

const directory = await mkdtemp(join(tmpdir(), "desktop-badge-"));
const badges: number[] = [];
const events: Array<{ channel: string; value: unknown }> = [];
let received: ((_event: unknown, info: Record<string, unknown>) => void) | null = null;
mock.module("electron", { defaultExport: {
  app: { getPath: () => directory, isPackaged: false, isReady: () => true, setBadgeCount: (count: number) => { badges.push(count); return true; } },
  Notification: { getHistory: async () => [] },
  pushNotifications: { on: (_event: string, listener: typeof received) => { received = listener; }, unregisterForAPNSNotifications() {} },
} });
mock.module("../main/auth.js", { namedExports: { apiFetch: async () => ({}) } });
mock.module("../main/window.js", { namedExports: {
  createWindow() {}, focusMainWindow() {}, hasOpenWindows: () => true,
  emitToMainWindow: (channel: string, value: unknown) => { events.push({ channel, value }); },
} });
const notifications = await import("../main/notifications.js");

test("native badge updates, clearing on sign-out, and push invalidation reach Electron", async () => {
  try {
    notifications.setDesktopNotificationBadgeCount(12);
    notifications.setDesktopNotificationBadgeCount(0);
    for (const invalid of [-1, 1.5, NaN, Infinity, "3", 2 ** 31]) {
      assert.throws(() => notifications.setDesktopNotificationBadgeCount(invalid), /non-negative integer/);
    }
    if (["darwin", "linux"].includes(process.platform)) assert.deepEqual(badges, [12, 0]);
    notifications.setDesktopNotificationBadgeCount(7);
    await notifications.setDesktopNotificationsEnabled(true);
    if (["darwin", "linux"].includes(process.platform)) assert.deepEqual(badges.slice(-2), [7, 7], "granting notification permission reapplies the count");
    await notifications.unregisterDesktopNotificationAccount();
    if (["darwin", "linux"].includes(process.platform)) assert.equal(badges.at(-1), 0);
    notifications.prepareDesktopNotifications();
    if (process.platform === "darwin") {
      received!({}, { letagents: { notification_id: "notification-1", room_id: "room-a", message_id: "msg_3", thread_root_id: null } });
      assert.equal(events.at(-1)?.channel, "desktop:notifications:received");
      assert.deepEqual(events.at(-1)?.value, { notificationId: "notification-1", roomIdentifier: "room-a", messageId: "msg_3", threadRootId: null });
      // Let the asynchronous target write settle before removing its test directory.
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
