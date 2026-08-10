import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RentalProviderEventPoller } from "../rental/provider-event-poller.js";

test("persists the durable cursor and emits only sanitized provider refresh metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "letagents-rental-events-"));
  const path = join(directory, "cursor.json");
  const previous = process.env.LETAGENTS_RENTAL_PROVIDER_EVENT_STATE_PATH;
  process.env.LETAGENTS_RENTAL_PROVIDER_EVENT_STATE_PATH = path;
  let requestedAfter: string | null | undefined;
  let wake!: () => void;
  const emitted = new Promise<void>((resolve) => { wake = resolve; });
  const events: unknown[] = [];
  const handled: unknown[] = [];
  const poller = new RentalProviderEventPoller(
    {
      async providerEvents(after?: string | null) {
        requestedAfter = after;
        return { ok: true as const, status: 200, body: {
          events: [{
            id: "rpevt_secret_internal",
            kind: "request.created",
            session_id: "rsess_1",
            provider_account_id: "account_secret",
            payload: { renterPrompt: "must not cross IPC" },
          }],
          cursor: "durable-cursor-1",
        } };
      },
    } as never,
    (event) => { events.push(event); wake(); },
    async (event) => { handled.push(event); },
  );
  try {
    poller.start();
    await emitted;
    await poller.stop();
    assert.equal(requestedAfter, null);
    assert.deepEqual(events, [{ kind: "request.created", sessionId: "rsess_1" }]);
    assert.deepEqual(handled, events);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      version: 1,
      cursor: "durable-cursor-1",
    });
  } finally {
    if (previous === undefined) delete process.env.LETAGENTS_RENTAL_PROVIDER_EVENT_STATE_PATH;
    else process.env.LETAGENTS_RENTAL_PROVIDER_EVENT_STATE_PATH = previous;
  }
});

test("does not advance the cursor when handling fails, so restart replays the durable event", async () => {
  const directory = await mkdtemp(join(tmpdir(), "letagents-rental-events-replay-"));
  const path = join(directory, "cursor.json");
  const previous = process.env.LETAGENTS_RENTAL_PROVIDER_EVENT_STATE_PATH;
  process.env.LETAGENTS_RENTAL_PROVIDER_EVENT_STATE_PATH = path;
  let firstAttempt!: () => void;
  const attempted = new Promise<void>((resolve) => { firstAttempt = resolve; });
  const payload = {
    events: [{ kind: "request.cancelled", session_id: "rsess_replay", payload: { secret: true } }],
    cursor: "cursor-after-replay",
  };
  const first = new RentalProviderEventPoller(
    { async providerEvents() { return { ok: true as const, status: 200, body: payload }; } } as never,
    () => assert.fail("an unhandled event must not cross IPC"),
    async () => { firstAttempt(); throw new Error("daemon temporarily offline"); },
  );
  try {
    first.start();
    await attempted;
    await first.stop();
    await assert.rejects(readFile(path, "utf8"), { code: "ENOENT" });

    let requestedAfter: string | null | undefined;
    let wake!: () => void;
    const replayed = new Promise<void>((resolve) => { wake = resolve; });
    const seen: unknown[] = [];
    const second = new RentalProviderEventPoller(
      {
        async providerEvents(after?: string | null) {
          requestedAfter = after;
          return { ok: true as const, status: 200, body: payload };
        },
      } as never,
      (event) => { seen.push(event); wake(); },
    );
    second.start();
    await replayed;
    await second.stop();
    assert.equal(requestedAfter, null);
    assert.deepEqual(seen, [{ kind: "request.cancelled", sessionId: "rsess_replay" }]);
    assert.equal(JSON.parse(await readFile(path, "utf8")).cursor, "cursor-after-replay");
  } finally {
    if (previous === undefined) delete process.env.LETAGENTS_RENTAL_PROVIDER_EVENT_STATE_PATH;
    else process.env.LETAGENTS_RENTAL_PROVIDER_EVENT_STATE_PATH = previous;
  }
});
