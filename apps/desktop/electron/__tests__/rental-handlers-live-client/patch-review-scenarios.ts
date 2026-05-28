import assert from "node:assert/strict";
import test from "node:test";

import { patchRow } from "./fixtures.js";
import { captureHandlersWithClient, invoke, makeFakeClient } from "./harness.js";

test("rental IPC maps live patch review API responses when an apiClient is provided", async () => {
  const { client, calls } = makeFakeClient({
    getPatches: {
      ok: true,
      status: 200,
      body: { patches: [patchRow()] },
    },
    approvePatch: {
      ok: true,
      status: 200,
      body: {
        patch: {
          id: "rpatch_1",
          session_id: "rsess_1",
          source: "explicit_patch",
          gate_status: "passed",
          check_results: {
            review: { pr_url: "https://github.com/BrosInCode/letagents/pull/1" },
          },
          updated_at: "2026-05-11T10:01:00.000Z",
        },
      },
    },
    requestPatchChanges: {
      ok: true,
      status: 200,
      body: {
        patch: {
          id: "rpatch_1",
          session_id: "rsess_1",
          source: "explicit_patch",
          gate_status: "needs_revision",
          updated_at: "2026-05-11T10:02:00.000Z",
        },
      },
    },
  });
  const handlers = captureHandlersWithClient(client);

  const patches = await invoke(handlers, "desktop:rental:get-patches", "rsess_1");
  assert.equal((patches as Array<{ id: string }>)[0]!.id, "rpatch_1");

  const approved = await invoke(handlers, "desktop:rental:approve-patch", "rsess_1", "rpatch_1");
  assert.equal(
    (approved as { prUrl: string }).prUrl,
    "https://github.com/BrosInCode/letagents/pull/1",
  );

  const changed = await invoke(
    handlers,
    "desktop:rental:request-patch-changes",
    "rsess_1",
    "rpatch_1",
    "Please tighten tests",
  );
  assert.equal((changed as { gateStatus: string }).gateStatus, "needs_revision");

  assert.equal(calls[0]?.method, "getPatches");
  assert.equal(calls[0]?.args[0], "rsess_1");
  assert.equal(calls[1]?.method, "approvePatch");
  assert.deepEqual(calls[1]?.args, ["rsess_1", "rpatch_1"]);
  assert.equal(calls[2]?.method, "requestPatchChanges");
  assert.deepEqual(calls[2]?.args.slice(0, 2), ["rsess_1", "rpatch_1"]);
  assert.equal((calls[2]?.args[2] as { note?: string }).note, "Please tighten tests");
});
