/**
 * Route tests for p5.3 MCP patch and command broker endpoints.
 */

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type http from "node:http";

let app: import("express").Express;
let server: http.Server;
let baseUrl: string;
let appendCalls: unknown[];
let patchCalls: unknown[];
let commandCalls: unknown[];
let events: unknown[];

beforeEach(async () => {
  process.env.LETAGENTS_RENT_ENABLED = "true";
  appendCalls = [];
  patchCalls = [];
  commandCalls = [];
  events = [];

  const express = (await import("express")).default;
  const { registerRentalInternalRoutes } = await import("../routes/rental-internal.js");
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as Record<string, unknown>).sessionAccount = { account_id: "acct_provider" };
    next();
  });
  registerRentalInternalRoutes(app, {
    ingestUsage: async () => ({} as never),
    reserveBudget: async () => ({} as never),
    reconcileBudget: async () => ({} as never),
    resolveSessionAccess: async () => "provider",
    heartbeatDeps: async () => ({} as never),
    getSessionForLiveness: async () => null,
    getSessionLifecycle: async () => ({ status: "active" as never, room_id: "room_1" }),
    updateSessionLifecycle: async () => null,
    emitActivityEvent: async (input) => {
      events.push(input);
      return { id: `evt_${events.length}` } as never;
    },
    readContextFile: async () => ({ success: false, error: "not used" }),
    searchContext: async () => ({ success: false, error: "not used" }),
    appendSignedChange: async (sessionId, input) => {
      appendCalls.push({ sessionId, input });
      return {
        proposal: {
          id: "rpatch_edit",
          gate_status: "pending",
          diff_ref: "sha256:diff",
        },
        entry: { path: input.edit.path, summary: input.edit.summary },
        patch: "diff --git a/src/index.ts b/src/index.ts\n",
        idempotent: false,
      } as never;
    },
    proposePatch: async (sessionId, input) => {
      patchCalls.push({ sessionId, input });
      return {
        proposal: { id: "rpatch_patch", gate_status: "passed" },
        gate: { warnings: [], rejectionReasons: [], checks: [] },
        idempotent: false,
      } as never;
    },
    runWorkspaceCommand: async (sessionId, input) => {
      commandCalls.push({ sessionId, input });
      return {
        success: true,
        argv: input.argv,
        exitCode: 0,
        stdout: "ok",
        stderr: "",
      };
    },
  });
  server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address() as import("net").AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  delete process.env.LETAGENTS_RENT_ENABLED;
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function post(route: string, body: unknown) {
  return fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("p5.3 internal patch tool routes", () => {
  it("wires propose-edit into the Signed Change Journal dependency", async () => {
    const res = await post("/api/rental/sessions/rsess_1/patches/propose-edit", {
      idempotencyKey: "edit-1",
      path: "src/index.ts",
      beforeContent: "old\n",
      afterContent: "new\n",
    });

    assert.equal(res.status, 201);
    const json = (await res.json()) as { success: boolean; proposalId: string };
    assert.equal(json.success, true);
    assert.equal(json.proposalId, "rpatch_edit");
    assert.equal(appendCalls.length, 1);
    assert.equal(events.length, 1);
  });

  it("wires propose-patch into Patch Gate persistence", async () => {
    const res = await post("/api/rental/sessions/rsess_1/patches/propose-patch", {
      idempotencyKey: "patch-1",
      files: [{ path: "src/index.ts", operation: "modify", content: "new\n" }],
    });

    assert.equal(res.status, 201);
    const json = (await res.json()) as { success: boolean; gateStatus: string };
    assert.equal(json.success, true);
    assert.equal(json.gateStatus, "passed");
    assert.equal(patchCalls.length, 1);
    assert.equal(events.length, 2);
  });

  it("wires run-command into the Command Broker dependency", async () => {
    const res = await post("/api/rental/sessions/rsess_1/commands/run", {
      argv: ["node", "--test", "sample.test.mjs"],
      timeoutMs: 1000,
    });

    assert.equal(res.status, 200);
    const json = (await res.json()) as { success: boolean; stdout: string };
    assert.equal(json.success, true);
    assert.equal(json.stdout, "ok");
    assert.equal(commandCalls.length, 1);
    assert.equal(events.length, 4);
  });
});
