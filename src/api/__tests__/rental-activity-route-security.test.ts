import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

test("manual rental activity emission cannot forge verified tool/system events", async () => {
  process.env.LETAGENTS_RENT_ENABLED = "true";
  const express = (await import("express")).default;
  const { registerActivityLifecycleRoutes } = await import("../routes/rental/internal/activity-lifecycle-routes.js");
  let captured: Record<string, unknown> | null = null;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as Record<string, unknown>).sessionAccount = { account_id: "acct_provider" };
    next();
  });
  registerActivityLifecycleRoutes(app, {
    resolveSessionAccess: async () => "provider",
    getSessionLifecycle: async () => ({ room_id: "room_1" }),
    emitActivityEvent: async (input: Record<string, unknown>) => {
      captured = input;
      return { id: "evt_1", ...input };
    },
  } as never);

  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    const addr = server.address() as import("net").AddressInfo;
    const response = await fetch(`http://127.0.0.1:${addr.port}/api/rental/sessions/rsess_1/activity`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event_type: "command.output",
        source: "system",
        verified: true,
        payload: { ok: true },
      }),
    });
    assert.equal(response.status, 201);
    assert.equal(captured?.source, "agent");
    assert.equal(captured?.verified, false);
    assert.equal(captured?.eventType, "command.output");
  } finally {
    delete process.env.LETAGENTS_RENT_ENABLED;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

