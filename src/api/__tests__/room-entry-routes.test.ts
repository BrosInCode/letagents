import assert from "node:assert/strict";
import test from "node:test";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { buildRoomEntryPath, registerRoomEntryRoutes } = await import("../routes/room-entry.js");

function createDeps() {
  return {
    isRepoBackedRoomId: () => false,
    resolveGitHubRoomEntryDecision: async () => ({ kind: "allow" as const }),
  };
}

test("registerRoomEntryRoutes preserves public entry route order", () => {
  const calls: Array<{ method: "get"; path: string }> = [];
  const app = {
    get(path: RegExp | string) {
      calls.push({ method: "get", path: path.toString() });
    },
  };

  registerRoomEntryRoutes(app as never, createDeps() as never);

  assert.deepEqual(calls, [
    { method: "get", path: "/^\\/api\\/rooms\\/resolve\\/(.+)$/" },
    { method: "get", path: "/:provider/:owner/:repo" },
    { method: "get", path: "/^\\/in\\/(.+)$/" },
    { method: "get", path: "/rooms/resolve/:identifier" },
  ]);
});

test("buildRoomEntryPath preserves the original room query string", () => {
  assert.equal(
    buildRoomEntryPath(
      "github.com/brosincode/letagents",
      "/in/github.com/BrosInCode/letagents?view=board"
    ),
    "/in/github.com/brosincode/letagents?view=board"
  );

  assert.equal(
    buildRoomEntryPath("github.com/brosincode/letagents", "/in/github.com/BrosInCode/letagents"),
    "/in/github.com/brosincode/letagents"
  );
});
