/**
 * Tests for the rental Context Broker (p4.4).
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import type http from "node:http";

import {
  readContextFile,
  searchContext,
  type ContextBrokerDeps,
  type ContextWorkspaceManifest,
} from "../rental/context-broker.js";
import type { RecordExposureInput } from "../rental/exposure-ledger.js";

let workspaceRoot: string;

before(async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "context-broker-test-"));
  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await fs.writeFile(
    path.join(workspaceRoot, "src", "index.ts"),
    [
      "export function greet(name: string) {",
      "  return `hello ${name}`;",
      "}",
    ].join("\n"),
  );
  await fs.writeFile(
    path.join(workspaceRoot, "src", "secret.ts"),
    'export const token = "ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ";',
  );
  await fs.writeFile(path.join(workspaceRoot, ".env"), "TOKEN=do-not-read");
});

after(async () => {
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

function makeDeps(exposures: RecordExposureInput[] = []): ContextBrokerDeps {
  const manifest: ContextWorkspaceManifest = {
    id: "manifest_1",
    session_id: "rsess_1",
    workspace_path: workspaceRoot,
    retention_status: "active",
  };
  return {
    async getActiveManifest() {
      return manifest;
    },
    async recordExposure(input) {
      exposures.push(input);
      return input;
    },
  };
}

describe("ContextBroker readContextFile", () => {
  it("reads a scoped file and records a file exposure", async () => {
    const exposures: RecordExposureInput[] = [];
    const result = await readContextFile(makeDeps(exposures), {
      sessionId: "rsess_1",
      path: "src/index.ts",
      requestedBy: "acct_1",
    });

    assert.equal(result.success, true);
    assert.equal(result.path, "src/index.ts");
    assert.match(result.content ?? "", /hello/);
    assert.equal(result.secretScanStatus, "passed");
    assert.equal(exposures.length, 1);
    assert.equal(exposures[0]!.path, "src/index.ts");
    assert.equal(exposures[0]!.exposureType, "file");
    assert.equal(exposures[0]!.requestedBy, "acct_1");
  });

  it("redacts secret content before returning and recording it", async () => {
    const exposures: RecordExposureInput[] = [];
    const result = await readContextFile(makeDeps(exposures), {
      sessionId: "rsess_1",
      path: "src/secret.ts",
    });

    assert.equal(result.success, true);
    assert.equal(result.secretScanStatus, "redacted");
    assert.match(result.content ?? "", /REDACTED_GITHUB_PAT/);
    assert.ok(!result.content?.includes("ghp_abcdefghijklmnopqrstuvwxyz"));
    assert.match(String(exposures[0]!.content), /REDACTED_GITHUB_PAT/);
  });

  it("blocks denylisted paths and records the blocked request", async () => {
    const exposures: RecordExposureInput[] = [];
    const result = await readContextFile(makeDeps(exposures), {
      sessionId: "rsess_1",
      path: ".env",
    });

    assert.equal(result.success, false);
    assert.equal(result.error, "secret_blocked");
    assert.equal(result.secretScanStatus, "blocked");
    assert.equal(exposures[0]!.secretScanStatus, "blocked");
  });

  it("rejects traversal before touching the workspace", async () => {
    const exposures: RecordExposureInput[] = [];
    const result = await readContextFile(makeDeps(exposures), {
      sessionId: "rsess_1",
      path: "../outside.txt",
    });

    assert.equal(result.success, false);
    assert.equal(result.error, "path_traversal_rejected");
    assert.equal(exposures.length, 0);
  });
});

describe("ContextBroker searchContext", () => {
  it("searches literal text, returns snippets, and records search_result exposures", async () => {
    const exposures: RecordExposureInput[] = [];
    const result = await searchContext(makeDeps(exposures), {
      sessionId: "rsess_1",
      query: "hello",
      maxResults: 5,
      requestedBy: "acct_search",
    });

    assert.equal(result.success, true);
    assert.equal(result.count, 1);
    assert.equal(result.results?.[0]?.path, "src/index.ts");
    assert.equal(result.results?.[0]?.line, 2);
    assert.match(result.results?.[0]?.preview ?? "", /hello/);
    assert.equal(exposures.length, 1);
    assert.equal(exposures[0]!.exposureType, "search_result");
    assert.equal(exposures[0]!.requestedBy, "acct_search");
  });

  it("does not search denylisted files", async () => {
    const exposures: RecordExposureInput[] = [];
    const result = await searchContext(makeDeps(exposures), {
      sessionId: "rsess_1",
      query: "do-not-read",
      maxResults: 5,
    });

    assert.equal(result.success, true);
    assert.equal(result.count, 0);
    assert.deepEqual(result.results, []);
    assert.equal(exposures.length, 0);
  });
});

describe("Context Broker internal routes", () => {
  let app: import("express").Express;
  let server: http.Server;
  let baseUrl: string;
  let access: "renter" | "provider" | null;
  let readCalls: Array<{ sessionId: string; input: Record<string, unknown> }>;
  let searchCalls: Array<{ sessionId: string; input: Record<string, unknown> }>;

  beforeEach(async () => {
    process.env.LETAGENTS_RENT_ENABLED = "true";
    process.env.DB_URL = "postgresql://postgres:postgres@localhost:5432/letagents_test";
    access = "provider";
    readCalls = [];
    searchCalls = [];

    const express = (await import("express")).default;
    const { registerRentalInternalRoutes } = await import("../routes/rental-internal.js");
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as Record<string, unknown>).sessionAccount = { account_id: "acct_route" };
      next();
    });
    registerRentalInternalRoutes(app, {
      ingestUsage: async () => ({} as never),
      reserveBudget: async () => ({} as never),
      reconcileBudget: async () => ({} as never),
      resolveSessionAccess: async () => access,
      heartbeatDeps: async () => ({} as never),
      getSessionForLiveness: async () => null,
      getSessionLifecycle: async () => null,
      updateSessionLifecycle: async () => null,
      emitActivityEvent: async () => ({} as never),
      readContextFile: async (sessionId, input) => {
        readCalls.push({ sessionId, input });
        return {
          success: true,
          path: input.path,
          content: "hello",
          secretScanStatus: "passed",
        };
      },
      searchContext: async (sessionId, input) => {
        searchCalls.push({ sessionId, input });
        return {
          success: true,
          query: input.query,
          results: [],
          count: 0,
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
    delete process.env.DB_URL;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function post(route: string, body: unknown) {
    return fetch(`${baseUrl}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("wires read-file through session access and injects requestedBy", async () => {
    const res = await post("/api/rental/sessions/rsess_1/context/read-file", {
      path: "src/index.ts",
      maxBytes: 1234,
    });

    assert.equal(res.status, 200);
    const json = (await res.json()) as { success: boolean; content: string };
    assert.equal(json.success, true);
    assert.equal(json.content, "hello");
    assert.deepEqual(readCalls, [
      {
        sessionId: "rsess_1",
        input: {
          path: "src/index.ts",
          maxBytes: 1234,
          requestedBy: "acct_route",
        },
      },
    ]);
  });

  it("maps blocked file responses to 403", async () => {
    readCalls = [];
    const express = (await import("express")).default;
    const { registerRentalInternalRoutes } = await import("../routes/rental-internal.js");
    const blockedApp = express();
    blockedApp.use(express.json());
    blockedApp.use((req, _res, next) => {
      (req as Record<string, unknown>).sessionAccount = { account_id: "acct_route" };
      next();
    });
    registerRentalInternalRoutes(blockedApp, {
      ingestUsage: async () => ({} as never),
      reserveBudget: async () => ({} as never),
      reconcileBudget: async () => ({} as never),
      resolveSessionAccess: async () => "provider",
      heartbeatDeps: async () => ({} as never),
      getSessionForLiveness: async () => null,
      getSessionLifecycle: async () => null,
      updateSessionLifecycle: async () => null,
      emitActivityEvent: async () => ({} as never),
      readContextFile: async () => ({ success: false, error: "secret_blocked" }),
      searchContext: async () => ({ success: true, results: [], count: 0 }),
    });
    const srv = await new Promise<http.Server>((resolve) => {
      const s = blockedApp.listen(0, () => resolve(s));
    });
    try {
      const addr = srv.address() as import("net").AddressInfo;
      const res = await fetch(
        `http://127.0.0.1:${addr.port}/api/rental/sessions/rsess_1/context/read-file`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: ".env" }),
        },
      );
      assert.equal(res.status, 403);
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });

  it("wires search options through the context route", async () => {
    const res = await post("/api/rental/sessions/rsess_1/context/search", {
      query: "hello",
      maxResults: 7,
      caseSensitive: true,
    });

    assert.equal(res.status, 200);
    assert.deepEqual(searchCalls, [
      {
        sessionId: "rsess_1",
        input: {
          query: "hello",
          maxResults: 7,
          caseSensitive: true,
          requestedBy: "acct_route",
        },
      },
    ]);
  });
});
