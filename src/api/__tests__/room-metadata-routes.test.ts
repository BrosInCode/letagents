import assert from "node:assert/strict";
import test from "node:test";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { registerRoomMetadataRoutes } = await import("../routes/room-metadata.js");

function createDeps() {
  const unused = async () => {
    throw new Error("not invoked");
  };

  return {
    resolveCanonicalRoomRequestId: unused,
    resolveRoomOrReply: unused,
    requireAdmin: unused,
    resolveProjectRole: unused,
    toRoomResponse: () => ({}),
  };
}

test("registerRoomMetadataRoutes preserves canonical metadata route order", () => {
  const calls: Array<{ method: "patch"; path: string }> = [];
  const app = {
    patch(path: RegExp) {
      calls.push({ method: "patch", path: path.toString() });
    },
  };

  registerRoomMetadataRoutes(app as never, createDeps() as never);

  assert.deepEqual(calls, [
    { method: "patch", path: "/^\\/rooms\\/(.+)$/" },
  ]);
});
