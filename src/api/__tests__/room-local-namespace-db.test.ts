import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Response } from "express";

import { isDeviceLocalRoomIdShape } from "../rooms/room-nature.js";

const url = process.env.TEST_DB_URL;
if (url) process.env.DB_URL = url;
const client = url ? await import("../db/client.js") : null;
const roomRows = url ? await import("../db/room-rows.js") : null;
const db = url ? await import("../db.js") : null;
const resolution = url ? await import("../rooms/resolution.js") : null;
const options = { skip: !url ? "Set TEST_DB_URL for PostgreSQL integration tests." : false };

test.before(async () => { if (client) await migrate(client.db, { migrationsFolder: resolve("drizzle") }); });
test.after(async () => { await client?.pool.end(); });

const suffix = Date.now().toString(16).slice(-10).padStart(10, "0");

function fakeResponse() {
  const res = {
    statusCode: 200,
    body: null as unknown,
    status(code: number) { res.statusCode = code; return res; },
    json(body: unknown) { res.body = body; return res; },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

test("the device-local id shape is local- or local_, any case", () => {
  for (const id of ["local-a-0123456789", "Local_5c489963", "LOCAL-x"]) assert.equal(isDeviceLocalRoomIdShape(id), true, id);
  for (const id of ["locale-x", "github.com/a/b", "my-local-room", "localhost"]) assert.equal(isDeviceLocalRoomIdShape(id), false, id);
});

test("a request cannot create a local- or local_ room, and nothing is stored", options, async () => {
  for (const id of [`local-folder-${suffix}`, `Local_${suffix}`]) {
    await assert.rejects(() => db!.getOrCreateCanonicalRoom(id), /kept for rooms on one device/);
    assert.equal(await db!.getProjectById(id), undefined);

    const res = fakeResponse();
    assert.equal(await resolution!.resolveRoomOrReply(id, res, { allowCreate: true }), null);
    assert.equal(res.statusCode, 404);
    assert.match(String((res as unknown as { body: { error: string } }).body.error), /kept for rooms on one device/);
    assert.equal(await db!.getProjectById(id), undefined);
  }
});

test("an existing room with a local- id still opens, with or without create", options, async () => {
  const id = `local-existing-${suffix}`;
  await roomRows!.insertRoomRow(client!.db, {
    id, display_name: "fern-river", origin: "named", created_at: new Date().toISOString(),
  });
  const opened = await db!.getOrCreateCanonicalRoom(id);
  assert.equal(opened.created, false);
  assert.equal(opened.room.id, id);
  for (const allowCreate of [true, false]) {
    const res = fakeResponse();
    const room = await resolution!.resolveRoomOrReply(id, res, { allowCreate });
    assert.equal(room?.id, id);
    assert.equal(res.statusCode, 200);
  }
});
