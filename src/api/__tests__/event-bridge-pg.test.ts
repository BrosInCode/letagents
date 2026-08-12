import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";

const testDatabaseUrl = process.env.TEST_DB_URL;
const workerPath = fileURLToPath(new URL("./event-bridge-pg-worker.ts", import.meta.url));

function startWorker(
  role: "publisher" | "subscriber",
  roomId: string,
  scenario = "loss",
): ChildProcess {
  return fork(workerPath, [], {
    execArgv: ["--import", "tsx"],
    env: {
      ...process.env,
      DB_URL: testDatabaseUrl,
      LETAGENTS_BRIDGE_TEST_ROLE: role,
      LETAGENTS_BRIDGE_TEST_ROOM: roomId,
      LETAGENTS_BRIDGE_TEST_SCENARIO: scenario,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
}

function waitForMessage(
  child: ChildProcess,
  type: string,
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    const timeout = setTimeout(() => finish(new Error(`timed out waiting for ${type}: ${stderr}`)), timeoutMs);
    const onMessage = (message: unknown) => {
      if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== type) return;
      finish(null, message as Record<string, unknown>);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(new Error(`bridge worker exited before ${type} (${code ?? signal}): ${stderr}`));
    };
    const finish = (error: Error | null, value?: Record<string, unknown>) => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve(value!);
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    return child.exitCode === 0
      ? Promise.resolve()
      : Promise.reject(new Error(`bridge worker failed (${child.exitCode})`));
  }
  if (child.signalCode !== null) {
    return Promise.reject(new Error(`bridge worker failed (${child.signalCode})`));
  }
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`bridge worker failed (${code ?? signal})`));
    });
  });
}

test("publisher drops cross a real PostgreSQL bridge as a sticky gap before later events", {
  skip: testDatabaseUrl ? false : "set TEST_DB_URL to run the PostgreSQL bridge convergence test",
  timeout: 30_000,
}, async () => {
  const roomId = `bridge-test-${randomUUID()}`;
  const subscriber = startWorker("subscriber", roomId);
  let publisher: ChildProcess | null = null;
  try {
    await waitForMessage(subscriber, "subscriber_ready");
    publisher = startWorker("publisher", roomId);
    const [result] = await Promise.all([
      waitForMessage(subscriber, "subscriber_result"),
      waitForMessage(publisher, "publisher_done"),
    ]);
    assert.deepEqual(result.deliveries, ["gap", "event"]);
    assert.equal(result.message, "converged");
    await Promise.all([waitForExit(subscriber), waitForExit(publisher)]);
  } finally {
    if (subscriber.exitCode === null && subscriber.signalCode === null) subscriber.kill();
    if (publisher && publisher.exitCode === null && publisher.signalCode === null) publisher.kill();
  }
});

test("repository access invalidation wakes a live authorization lease on another API process", {
  skip: testDatabaseUrl ? false : "set TEST_DB_URL to run the PostgreSQL bridge convergence test",
  timeout: 30_000,
}, async () => {
  const roomId = `github.com/bridge-test/${randomUUID()}`;
  const subscriber = startWorker("subscriber", roomId, "auth_invalidation");
  let publisher: ChildProcess | null = null;
  try {
    await waitForMessage(subscriber, "subscriber_ready");
    publisher = startWorker("publisher", roomId, "auth_invalidation");
    const [result] = await Promise.all([
      waitForMessage(subscriber, "subscriber_invalidation_result"),
      waitForMessage(publisher, "publisher_done"),
    ]);
    assert.equal(result.allowed, false, "remote revocation is observed without waiting for lease expiry");
    await Promise.all([waitForExit(subscriber), waitForExit(publisher)]);
  } finally {
    if (subscriber.exitCode === null && subscriber.signalCode === null) subscriber.kill();
    if (publisher && publisher.exitCode === null && publisher.signalCode === null) publisher.kill();
  }
});

test("an uninterested API process skips remote reference hydration and records a repair gap", {
  skip: testDatabaseUrl ? false : "set TEST_DB_URL to run the PostgreSQL bridge interest test",
  timeout: 30_000,
}, async () => {
  const roomId = `bridge-interest-${randomUUID()}`;
  const subscriber = startWorker("subscriber", roomId, "uninterested_ref");
  let publisher: ChildProcess | null = null;
  try {
    await waitForMessage(subscriber, "subscriber_ready");
    publisher = startWorker("publisher", roomId, "uninterested_ref");
    const [result] = await Promise.all([
      waitForMessage(subscriber, "subscriber_interest_result"),
      waitForMessage(publisher, "publisher_done"),
    ]);
    assert.equal(result.reason, "uninterested_reference");
    assert.equal(result.room_id, roomId);
    await Promise.all([waitForExit(subscriber), waitForExit(publisher)]);
  } finally {
    if (subscriber.exitCode === null && subscriber.signalCode === null) subscriber.kill();
    if (publisher && publisher.exitCode === null && publisher.signalCode === null) publisher.kill();
  }
});

test("a transaction-coupled credential rotation retires an old live lease on another API process", {
  skip: testDatabaseUrl ? false : "set TEST_DB_URL to run the PostgreSQL credential bridge test",
  timeout: 30_000,
}, async () => {
  const roomId = `bridge-credential-${randomUUID()}`;
  const subscriber = startWorker("subscriber", roomId, "credential_invalidation");
  let publisher: ChildProcess | null = null;
  try {
    await waitForMessage(subscriber, "subscriber_ready");
    publisher = startWorker("publisher", roomId, "credential_invalidation");
    const [result] = await Promise.all([
      waitForMessage(subscriber, "subscriber_credential_result"),
      waitForMessage(publisher, "publisher_done"),
    ]);
    assert.equal(result.allowed, false, "v1 lease closes without waiting for its 60-second TTL");
    await Promise.all([waitForExit(subscriber), waitForExit(publisher)]);
  } finally {
    if (subscriber.exitCode === null && subscriber.signalCode === null) subscriber.kill();
    if (publisher && publisher.exitCode === null && publisher.signalCode === null) publisher.kill();
  }
});

test("a stopped listener can restart without retaining duplicate PostgreSQL handlers", {
  skip: testDatabaseUrl ? false : "set TEST_DB_URL to run the PostgreSQL bridge restart test",
  timeout: 30_000,
}, async () => {
  const roomId = `bridge-restart-${randomUUID()}`;
  const subscriber = startWorker("subscriber", roomId, "listener_restart");
  let publisher: ChildProcess | null = null;
  try {
    await waitForMessage(subscriber, "subscriber_ready");
    publisher = startWorker("publisher", roomId, "listener_restart");
    const [result] = await Promise.all([
      waitForMessage(subscriber, "subscriber_restart_result"),
      waitForMessage(publisher, "publisher_done"),
    ]);
    assert.equal(result.delivery, "event");
    assert.equal(result.message, "after-restart");
    await Promise.all([waitForExit(subscriber), waitForExit(publisher)]);
  } finally {
    if (subscriber.exitCode === null && subscriber.signalCode === null) subscriber.kill();
    if (publisher && publisher.exitCode === null && publisher.signalCode === null) publisher.kill();
  }
});

test("a timed-out bridge publish is rolled back and never appears later", {
  skip: testDatabaseUrl ? false : "set TEST_DB_URL to run the PostgreSQL bridge deadline test",
  timeout: 10_000,
}, async () => {
  process.env.DB_URL = testDatabaseUrl;
  const [{ executeBridgePublish }, { pool }, { Pool }] = await Promise.all([
    import("../server/event-bridge.js"),
    import("../db/client.js"),
    import("pg"),
  ]);
  const observerPool = new Pool({ connectionString: testDatabaseUrl });
  const observer = await observerPool.connect();
  const channel = `bridge_deadline_${randomUUID().replaceAll("-", "")}`;
  const notifications: string[] = [];
  observer.on("notification", (notification) => {
    if (notification.channel === channel && notification.payload) {
      notifications.push(notification.payload);
    }
  });
  try {
    await observer.query(`LISTEN "${channel}"`);
    await assert.rejects(
      executeBridgePublish(
        async (client) => {
          await client.query(
            "SELECT pg_sleep(0.5), pg_notify($1, $2)",
            [channel, "must-not-commit"],
          );
        },
        75,
      ),
      (error: unknown) => (
        error instanceof Error
        && (error as Error & { code?: string }).code === "57014"
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 650));
    assert.deepEqual(notifications, []);
  } finally {
    observer.release();
    await observerPool.end();
    await pool.end();
  }
});
