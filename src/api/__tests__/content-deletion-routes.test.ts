import assert from "node:assert/strict";
import test from "node:test";
process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { registerContentDeletionRoutes } = await import("../routes/rooms/content-deletion.js");
const { ContentDeletionError } = await import("../db/content-deletion.js");

test("content deletion requires human auth, admin scope, existing rooms and exact room confirmation", async () => {
  const handlers: Array<(req: any, res: any) => Promise<void>> = [];
  const calls: any[] = [];
  let previewHandler: (req: any, res: any) => Promise<void>;
  let admin = true;
  registerContentDeletionRoutes({ get(_path: unknown, handler: any) { previewHandler = handler; }, delete(_path: unknown, handler: any) { handlers.push(handler); } } as never, {
    resolveCanonicalRoomRequestId: async id => id,
    resolveRoomOrReply: async (id, _res, options) => { assert.equal(options.allowCreate, false); return { id } as never; },
    requireParticipant: async () => true,
    requireAdmin: async (_req, res) => { if (!admin) res.status(403).json({ error: "Admin required" }); return admin; },
    resolveProjectRole: async () => admin ? "admin" : "participant",
    previewRoom: async id => { calls.push(["preview", id]); return { children: [], counts: { messages: 3, threads: 1, tasks: 2, files: 0 } }; },
    deleteRoom: async id => { calls.push(["room", id]); return { deleted_room_ids: [id, "child-room"], parent_room_id: "parent-room" }; },
    deleteTask: async (...args) => { calls.push(["task", ...args]); return { deleted: true }; },
    deleteMessage: async input => { calls.push(input); if (input.messageId === "msg_9") throw new ContentDeletionError(409, "Busy"); return { deleted: true, message_ids: [input.messageId] }; },
    invalidate: id => { calls.push(["invalidate", id]); },
    cleanup: async () => {},
  });
  const response = () => ({ statusCode: 200, body: null as any, status(code: number) { this.statusCode = code; return this; }, json(body: any) { this.body = body; return this; } });
  const req = { sessionAccount: { account_id: "owner" }, authKind: "session", params: { 0: "example-room", 1: "msg_1", 2: "att_1" }, body: {} };
  let res = response(); await handlers[2]({ ...req, authKind: "agent_session" }, res); assert.equal(res.statusCode, 401); assert.equal(calls.length, 0);
  res = response(); await handlers[4](req, res); assert.equal(res.statusCode, 400); assert.equal(calls.length, 0);
  admin = false;
  res = response(); await handlers[1](req, res); assert.equal(res.statusCode, 403);
  res = response(); await handlers[3](req, res); assert.equal(res.statusCode, 403);
  res = response(); await handlers[0](req, res); assert.equal(res.statusCode, 200); assert.equal(calls[0].admin, false); assert.equal(calls[0].attachmentId, "att_1");
  admin = true;
  res = response(); await handlers[4]({ ...req, body: { confirmation: "example-room" } }, res); assert.equal(res.statusCode, 200);
  assert.ok(calls.some(call => call[0] === "room"));
  assert.ok(calls.some(call => call[0] === "invalidate" && call[1] === "child-room"));
  assert.ok(calls.some(call => call[0] === "invalidate" && call[1] === "parent-room"));
  res = response(); await handlers[2]({ ...req, params: { ...req.params, 1: "msg_9" } }, res); assert.equal(res.statusCode, 409);
  res = response(); await previewHandler!({ ...req, authKind: "agent_session" }, res); assert.equal(res.statusCode, 401);
  admin = false;
  res = response(); await previewHandler!(req, res); assert.equal(res.statusCode, 403);
  admin = true;
  res = response(); await previewHandler!(req, res); assert.equal(res.statusCode, 200);
  assert.equal(res.body.counts.messages, 3);

});
