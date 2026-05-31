/**
 * Tests for p5.4 renter patch review API and orchestration.
 */

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type http from "node:http";

import type {
  RentalPatchReviewDeps,
  RentalSessionRow,
} from "../rental/patch-review.js";
import type { RentalPatchReviewProjection } from "../rental/patch-review.js";
import type { RentalPatchProposalRow } from "../rental/signed-change-journal.js";

const {
  approvePatchForRenter,
  listPatchProposalsForReview,
  PatchReviewError,
  requestPatchChangesForRenter,
} = await import("../rental/patch-review.js");

const RENTER = "acct_renter";
const PROVIDER = "acct_provider";
const NOW = new Date("2026-05-12T10:00:00.000Z");

function makeSession(overrides: Partial<RentalSessionRow> = {}): RentalSessionRow {
  return {
    id: "rsess_1",
    renter_account_id: RENTER,
    provider_account_id: PROVIDER,
    room_id: "room_1",
    repo_provider: "github",
    repo_owner: "BrosInCode",
    repo_name: "letagents",
    base_branch: "staging",
    work_branch: "letagents/rent/session-1",
    task_title: "Fix failing tests",
    status: "active",
    ...overrides,
  } as RentalSessionRow;
}

function makePatch(overrides: Partial<RentalPatchProposalRow> = {}): RentalPatchProposalRow {
  return {
    id: "rpatch_1",
    session_id: "rsess_1",
    source: "explicit_patch",
    diff_ref: "sha256:diff",
    summary: "Fix tests",
    gate_status: "passed",
    risk_score: null,
    warnings: [],
    check_results: {
      checks: [{
        file: "src/index.ts",
        operation: "modify",
        passed: true,
        warnings: [],
        secretsRedacted: 0,
        sanitizedContent: 'export const fixed = true;\n',
      }],
      warnings: [],
    },
    journal_entry: {
      version: 1,
      files: [{
        path: "src/index.ts",
        operation: "modify",
        content: 'export const fixed = true;\n',
      }],
      proposedAt: "2026-05-12T09:00:00.000Z",
    },
    idempotency_key: "patch-1",
    request_hash: "request-hash",
    response_hash: "response-hash",
    created_at: new Date("2026-05-12T09:00:00.000Z"),
    updated_at: new Date("2026-05-12T09:00:00.000Z"),
    ...overrides,
  } as RentalPatchProposalRow;
}

function makeDeps(patch: RentalPatchProposalRow, session: RentalSessionRow) {
  const events: unknown[] = [];
  const transitions: string[] = [];
  const patchUpdates: unknown[] = [];
  const pullRequests: unknown[] = [];
  const deps: RentalPatchReviewDeps = {
    now: () => NOW,
    listPatches: async () => [patch],
    getPatch: async (_sessionId, patchId) => (patchId === patch.id ? patch : null),
    updatePatch: async (_sessionId, _patchId, update) => {
      patchUpdates.push(update);
      return {
        ...patch,
        gate_status: update.gateStatus ?? patch.gate_status,
        check_results: update.checkResults ?? patch.check_results,
        updated_at: update.updatedAt,
      } as RentalPatchProposalRow;
    },
    updateSessionStatus: async (_sessionId, status) => {
      transitions.push(status);
      return { ...session, status } as RentalSessionRow;
    },
    emitActivityEvent: async (input) => {
      events.push(input);
      return {
        id: `evt_${events.length}`,
        session_id: input.sessionId,
        room_id: input.roomId,
        event_type: input.eventType,
        source: input.source,
        verified: true,
        visibility: "rental_visible",
        payload: input.payload,
        created_at: NOW,
      };
    },
    openPullRequest: async (input) => {
      pullRequests.push(input);
      return {
        number: 422,
        url: "https://github.com/BrosInCode/letagents/pull/422",
        title: "Rental patch: Fix failing tests",
        headRef: "letagents/rent/session-1",
        baseRef: "staging",
        commitSha: "commit_1",
      };
    },
  };
  return { deps, events, transitions, patchUpdates, pullRequests };
}

describe("patch review orchestration", () => {
  it("lists patch proposals with review projection metadata", async () => {
    const patch = makePatch({
      source: "signed_change_journal",
      journal_entry: {
        version: 1,
        path: "src/index.ts",
        beforeContent: "old\n",
        afterContent: "new\n",
      },
      check_results: {
        review: { pr_url: "https://github.com/BrosInCode/letagents/pull/1" },
      },
    });
    const patches = await listPatchProposalsForReview("rsess_1", {
      listPatches: async () => [patch],
    });
    assert.equal(patches.length, 1);
    assert.match(patches[0]!.diff_preview ?? "", /diff --git a\/src\/index\.ts/);
    assert.equal(patches[0]!.pr_url, "https://github.com/BrosInCode/letagents/pull/1");
  });

  it("approve opens a GitHub PR, records review metadata, and advances active → patch_review → pr_opened", async () => {
    const session = makeSession({ status: "active" });
    const patch = makePatch({ gate_status: "passed_with_warnings" });
    const { deps, events, transitions, patchUpdates, pullRequests } = makeDeps(patch, session);

    const result = await approvePatchForRenter(
      session,
      RENTER,
      patch.id,
      { note: "ship it" },
      deps,
    );

    assert.equal(result.pullRequest?.url, "https://github.com/BrosInCode/letagents/pull/422");
    assert.deepEqual(transitions, ["patch_review", "pr_opened"]);
    assert.equal(result.patch.pr_url, "https://github.com/BrosInCode/letagents/pull/422");
    assert.equal(events.length, 1);
    assert.equal((events[0] as { eventType: string }).eventType, "patch.approved");
    const review = (patchUpdates[0] as { checkResults: { review: Record<string, unknown> } })
      .checkResults.review;
    assert.equal(review.status, "approved");
    assert.equal(review.note, "ship it");
    assert.equal(review.commit_sha, "commit_1");
    const prInput = pullRequests[0] as {
      files: Array<{ path: string; operation: string; content?: string }>;
      commitMessage: string;
    };
    assert.deepEqual(prInput.files, [{
      path: "src/index.ts",
      operation: "modify",
      content: 'export const fixed = true;\n',
    }]);
    assert.match(prInput.commitMessage, /Patch: rpatch_1/);
  });

  it("approve uses sanitized patch content when preparing the pull request branch", async () => {
    const session = makeSession({ status: "patch_review" });
    const patch = makePatch({
      check_results: {
        checks: [{
          file: "src/index.ts",
          operation: "modify",
          passed: true,
          warnings: ["1 secret redacted"],
          secretsRedacted: 1,
          sanitizedContent: 'const token = "REDACTED";\n',
        }],
        warnings: [{ message: "secret redacted" }],
      },
      journal_entry: {
        version: 1,
        files: [{
          path: "./src/index.ts",
          operation: "modify",
          content: 'const token = "raw-secret";\n',
        }],
        proposedAt: "2026-05-12T09:00:00.000Z",
      },
    });
    const { deps, pullRequests } = makeDeps(patch, session);

    await approvePatchForRenter(session, RENTER, patch.id, {}, deps);

    const prInput = pullRequests[0] as {
      files: Array<{ path: string; operation: string; content?: string }>;
    };
    assert.deepEqual(prInput.files, [{
      path: "src/index.ts",
      operation: "modify",
      content: 'const token = "REDACTED";\n',
    }]);
  });

  it("idempotent approve repairs active sessions with existing approved PR metadata", async () => {
    const session = makeSession({ status: "active" });
    const patch = makePatch({
      check_results: {
        ...makePatch().check_results,
        review: {
          status: "approved",
          pr_url: "https://github.com/BrosInCode/letagents/pull/422",
          pr_number: 422,
          pr_title: "Rental patch: Fix failing tests",
          pr_head_ref: "letagents/rent/session-1",
          pr_base_ref: "staging",
        },
      },
    });
    const { deps, events, transitions, patchUpdates, pullRequests } = makeDeps(patch, session);

    const result = await approvePatchForRenter(session, RENTER, patch.id, {}, deps);

    assert.equal(result.idempotent, true);
    assert.equal(result.session.status, "pr_opened");
    assert.equal(result.pullRequest?.url, "https://github.com/BrosInCode/letagents/pull/422");
    assert.deepEqual(transitions, ["patch_review", "pr_opened"]);
    assert.equal(pullRequests.length, 0);
    assert.equal(patchUpdates.length, 0);
    assert.equal(events.length, 0);
  });

  it("request changes marks the patch needs_revision and returns patch_review sessions to active", async () => {
    const session = makeSession({ status: "patch_review" });
    const patch = makePatch({ gate_status: "needs_renter_approval" });
    const { deps, events, transitions, patchUpdates } = makeDeps(patch, session);

    const result = await requestPatchChangesForRenter(
      session,
      RENTER,
      patch.id,
      { note: "add regression tests" },
      deps,
    );

    assert.equal(result.patch.gate_status, "needs_revision");
    assert.deepEqual(transitions, ["active"]);
    assert.equal((events[0] as { eventType: string }).eventType, "patch.changes_requested");
    assert.equal((patchUpdates[0] as { gateStatus: string }).gateStatus, "needs_revision");
  });

  it("rejects provider approval attempts", async () => {
    const session = makeSession();
    const patch = makePatch();
    const { deps } = makeDeps(patch, session);
    await assert.rejects(
      () => approvePatchForRenter(session, PROVIDER, patch.id, {}, deps),
      (err) => err instanceof PatchReviewError && err.code === "not_renter",
    );
  });
});

describe("renter patch review routes", () => {
  let app: import("express").Express;
  let server: http.Server;
  let baseUrl: string;
  let deps: Record<string, unknown>;

  beforeEach(async () => {
    process.env.LETAGENTS_RENT_ENABLED = "true";
    const express = (await import("express")).default;
    const { registerRentalRenterRoutes } = await import("../routes/rental/renter/index.js");
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as Record<string, unknown>).sessionAccount = { account_id: RENTER };
      next();
    });

    const session = makeSession();
    const patch = makePatch();
    deps = {
      publicListings: async () => [],
      shouldAllowListingsQuery: () => true,
      createSession: async () => session,
      getSessionById: async () => session,
      cancelSession: async () => ({ ...session, status: "cancelled" }),
      listPatchProposals: async () => [patch as RentalPatchReviewProjection],
      approvePatch: async (
        _session: RentalSessionRow,
        _accountId: string,
        patchId: string,
        input: { note?: string | null } = {},
      ) => ({
        session: { ...session, status: "pr_opened" },
        patch: { ...patch, id: patchId, pr_url: "https://github.com/BrosInCode/letagents/pull/1", diff_preview: null },
        pullRequest: {
          number: 1,
          url: "https://github.com/BrosInCode/letagents/pull/1",
          title: "PR",
          headRef: "branch",
          baseRef: "staging",
        },
        event: null,
        idempotent: false,
        note: input.note,
      }),
      requestPatchChanges: async (
        _session: RentalSessionRow,
        _accountId: string,
        patchId: string,
        input: { note?: string | null } = {},
      ) => ({
        session,
        patch: { ...patch, id: patchId, gate_status: "needs_revision", pr_url: null, diff_preview: null },
        pullRequest: null,
        event: null,
        idempotent: false,
        note: input.note,
      }),
    };

    registerRentalRenterRoutes(app, deps as never);
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

  async function request(method: string, path: string, body?: unknown) {
    return fetch(`${baseUrl}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  it("GET /api/rental/sessions/:id/patches returns patch proposals", async () => {
    const res = await request("GET", "/api/rental/sessions/rsess_1/patches");
    assert.equal(res.status, 200);
    const json = (await res.json()) as { patches: Array<{ id: string }> };
    assert.equal(json.patches[0]!.id, "rpatch_1");
  });

  it("POST approve returns the review decision envelope", async () => {
    const res = await request(
      "POST",
      "/api/rental/sessions/rsess_1/patches/rpatch_1/approve",
      { note: "approved" },
    );
    assert.equal(res.status, 200);
    const json = (await res.json()) as { pullRequest: { url: string }; patch: { pr_url: string } };
    assert.equal(json.pullRequest.url, "https://github.com/BrosInCode/letagents/pull/1");
    assert.equal(json.patch.pr_url, "https://github.com/BrosInCode/letagents/pull/1");
  });

  it("POST request-changes returns a needs_revision patch", async () => {
    const res = await request(
      "POST",
      "/api/rental/sessions/rsess_1/patches/rpatch_1/request-changes",
      { note: "revise" },
    );
    assert.equal(res.status, 200);
    const json = (await res.json()) as { patch: { gate_status: string } };
    assert.equal(json.patch.gate_status, "needs_revision");
  });

  it("POST approve rejects non-object bodies", async () => {
    const res = await request(
      "POST",
      "/api/rental/sessions/rsess_1/patches/rpatch_1/approve",
      ["bad"],
    );
    assert.equal(res.status, 400);
  });
});
