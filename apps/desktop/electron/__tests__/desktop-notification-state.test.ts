import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { DesktopNotificationTarget } from "../ipc-types.js";
import {
  attachNotificationHistoryEntries,
  DesktopNotificationActivationState,
  DesktopNotificationStateStore,
  MAX_NOTIFICATION_TARGETS,
  type NotificationHistoryEntry,
} from "../main/notification-state.js";

function target(index: number): DesktopNotificationTarget {
  return {
    notificationId: `notification-${index}`,
    roomIdentifier: "git-room:example",
    messageId: `msg_${index}`,
    threadRootId: index > 1 ? "msg_1" : null,
  };
}

async function withTemporaryStateFile(
  run: (statePath: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "letagents-notification-state-"));
  try {
    await run(join(directory, "desktop-notifications.json"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("desktop notification state persists privately and survives a restart", async () => {
  await withTemporaryStateFile(async (statePath) => {
    const store = new DesktopNotificationStateStore(statePath, () => "installation-fixed");
    const current = await store.read();
    current.enabled = true;
    current.deviceToken = "a".repeat(64);
    await store.remember(target(1));

    const restored = await new DesktopNotificationStateStore(statePath).read();
    assert.equal(restored.enabled, true);
    assert.equal(restored.installationId, "installation-fixed");
    assert.equal(restored.deviceToken, "a".repeat(64));
    assert.deepEqual(restored.targets, [target(1)]);
    assert.equal((await stat(statePath)).mode & 0o777, 0o600);
    assert.doesNotMatch(await readFile(statePath, "utf8"), /undefined/);
  });
});

test("desktop notification state sanitizes, caps, and de-duplicates targets", async () => {
  await withTemporaryStateFile(async (statePath) => {
    const oversizedTargets = Array.from(
      { length: MAX_NOTIFICATION_TARGETS + 5 },
      (_, index) => target(index + 1),
    );
    await writeFile(statePath, JSON.stringify({
      enabled: "yes",
      installationId: "installation-existing",
      deviceToken: 123,
      lastError: false,
      targets: [{ invalid: true }, ...oversizedTargets],
    }));

    const store = new DesktopNotificationStateStore(statePath);
    const current = await store.read();
    assert.equal(current.enabled, false);
    assert.equal(current.deviceToken, null);
    assert.equal(current.targets.length, MAX_NOTIFICATION_TARGETS);
    assert.equal(current.targets[0]?.notificationId, "notification-6");

    await store.remember({ ...target(10), messageId: "msg_replaced" });
    assert.equal(current.targets.length, MAX_NOTIFICATION_TARGETS);
    assert.equal(current.targets.at(-1)?.notificationId, "notification-10");
    assert.equal(current.targets.at(-1)?.messageId, "msg_replaced");
    assert.equal(current.targets.filter((entry) => entry.notificationId === "notification-10").length, 1);
  });
});

test("cold-start activation is captured once and handed to the renderer once", () => {
  const activation = new DesktopNotificationActivationState();
  activation.captureDuringStartup(target(3));
  const startupTarget = activation.takeStartupTarget();
  assert.deepEqual(startupTarget, target(3));
  assert.equal(activation.takeStartupTarget(), null);

  activation.markActivated(startupTarget!);
  assert.deepEqual(activation.takePending(), target(3));
  assert.equal(activation.takePending(), null);
});

class FakeHistoryEntry implements NotificationHistoryEntry {
  private readonly listeners = new Map<"click" | "close", Array<() => void>>();

  constructor(readonly id: string) {}

  on(event: "click" | "close", listener: () => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }

  emit(event: "click" | "close"): void {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }

  listenerCount(event: "click" | "close"): number {
    return this.listeners.get(event)?.length ?? 0;
  }
}

test("notification history reattaches clicks idempotently and releases closed entries", () => {
  const known = new FakeHistoryEntry("notification-7");
  const unknown = new FakeHistoryEntry("notification-unknown");
  const restored = new Map<string, FakeHistoryEntry>();
  const activated: DesktopNotificationTarget[] = [];
  const input = {
    history: [known, unknown],
    targets: [target(7)],
    restored,
    activate: (value: DesktopNotificationTarget) => activated.push(value),
  };

  attachNotificationHistoryEntries(input);
  attachNotificationHistoryEntries(input);
  assert.equal(known.listenerCount("click"), 1);
  assert.equal(unknown.listenerCount("click"), 0);
  assert.equal(restored.get(known.id), known);

  known.emit("click");
  assert.deepEqual(activated, [target(7)]);
  known.emit("close");
  assert.equal(restored.has(known.id), false);
});
