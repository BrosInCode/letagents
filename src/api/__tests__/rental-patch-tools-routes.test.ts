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
let commandResult: {
  success: boolean;
  argv?: string[];
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  error?: string;
  timedOut?: boolean;
};

beforeEach(async () => {
  process.env.LETAGENTS_RENT_ENABLED = "true";
  appendCalls = [];
  patchCalls = [];
  commandCalls = [];
  events = [];
  commandResult = {
    success: true,
    exitCode: 0,
    stdout: "ok",
    stderr: "",
  };

  const express = (await import("express")).default;
  const { registerRentalInternalRoutes } = await import("../routes/rental/internal/index.js");
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
        ...commandResult,
        argv: commandResult.argv ?? input.argv,
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

  it("redacts command output before returning it or emitting activity", async () => {
    const fakeToken = "ghp_" + "A".repeat(36);
    commandResult = {
      success: false,
      exitCode: 1,
      stdout: `stdout token ${fakeToken}`,
      stderr: `stderr token ${fakeToken}`,
      error: `error token ${fakeToken}`,
    };

    const res = await post("/api/rental/sessions/rsess_1/commands/run", {
      argv: ["node", "--test", "sample.test.mjs"],
      timeoutMs: 1000,
    });

    assert.equal(res.status, 409);
    const json = (await res.json()) as { stdout: string; stderr: string; error: string };
    assert.ok(!json.stdout.includes(fakeToken));
    assert.ok(!json.stderr.includes(fakeToken));
    assert.ok(!json.error.includes(fakeToken));
    assert.ok(json.stdout.includes("REDACTED_GITHUB_PAT"));
    assert.ok(json.stderr.includes("REDACTED_GITHUB_PAT"));
    assert.ok(json.error.includes("REDACTED_GITHUB_PAT"));

    const outputEvent = events.find(
      (event) => (event as { eventType?: string }).eventType === "command.output",
    ) as { payload: Record<string, unknown> } | undefined;
    assert.ok(outputEvent);
    assert.ok(!(outputEvent.payload.stdout as string).includes(fakeToken));
    assert.ok(!(outputEvent.payload.stderr as string).includes(fakeToken));
    assert.ok(!(outputEvent.payload.error as string).includes(fakeToken));
    const firewall = outputEvent.payload.secret_firewall as {
      stdout_redacted: boolean;
      stderr_redacted: boolean;
      error_redacted: boolean;
      findings: unknown[];
    };
    assert.equal(firewall.stdout_redacted, true);
    assert.equal(firewall.stderr_redacted, true);
    assert.equal(firewall.error_redacted, true);
    assert.ok(firewall.findings.length >= 3);
  });

  it("redacts timed-out command errors before emitting activity", async () => {
    const fakeToken = "ghp_" + "B".repeat(36);
    commandResult = {
      success: false,
      timedOut: true,
      exitCode: null,
      stdout: "",
      stderr: "",
      error: `timed out after stderr included ${fakeToken}`,
    };

    const res = await post("/api/rental/sessions/rsess_1/commands/run", {
      argv: ["node", "--test", "slow.test.mjs"],
      timeoutMs: 1000,
    });

    assert.equal(res.status, 409);
    const json = (await res.json()) as { error: string };
    assert.ok(!json.error.includes(fakeToken));
    assert.ok(json.error.includes("REDACTED_GITHUB_PAT"));

    const timeoutEvent = events.find(
      (event) => (event as { eventType?: string }).eventType === "command.timed_out",
    ) as { payload: Record<string, unknown> } | undefined;
    assert.ok(timeoutEvent);
    assert.ok(!(timeoutEvent.payload.error as string).includes(fakeToken));
    assert.ok((timeoutEvent.payload.error as string).includes("REDACTED_GITHUB_PAT"));
    const firewall = timeoutEvent.payload.secret_firewall as {
      error_redacted: boolean;
      findings: unknown[];
    };
    assert.equal(firewall.error_redacted, true);
    assert.ok(firewall.findings.length >= 1);
  });
});
