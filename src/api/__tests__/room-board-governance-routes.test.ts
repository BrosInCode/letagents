import assert from "node:assert/strict";
import test from "node:test";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { registerRoomBoardRoutes } = await import("../routes/rooms/board.js");

type Handler = (req: Record<string, unknown>, res: Record<string, unknown>) => Promise<void>;

function createRouteApp() {
  const handlers = {
    get: new Map<string, Handler>(),
  };
  const app = {
    get(path: RegExp, handler: Handler) {
      handlers.get.set(path.toString(), handler);
    },
    patch() {},
    delete() {},
    post() {},
  };
  return { app, handlers };
}

test("registerRoomBoardRoutes exposes board governance read route", () => {
  const { app, handlers } = createRouteApp();
  registerRoomBoardRoutes(app as never, {
    resolveCanonicalRoomRequestId: async (roomId: string) => roomId,
    resolveRoomOrReply: async () => null,
    requireParticipant: async () => true,
    requireAdmin: async () => true,
    normalizeOptionalString: (value: unknown) => typeof value === "string" ? value.trim() || null : null,
  } as never);

  assert.ok(handlers.get.has("/^\\/rooms\\/(.+)\\/board-governance$/"));
});
