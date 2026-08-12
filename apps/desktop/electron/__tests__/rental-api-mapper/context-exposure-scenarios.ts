import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  mapApiContextApproval,
  mapApiContextApprovalArray,
  mapApiExposure,
  mapApiExposureArray,
} from "../../rental/api-mapper.js";

// ---------------------------------------------------------------------------
// mapApiExposure
// ---------------------------------------------------------------------------

describe("mapApiExposure", () => {
  it("maps a rental_workspace_exposures row into the desktop shape", () => {
    const exposure = mapApiExposure({
      id: "rexpo_1",
      session_id: "rsess_1",
      path: "src/index.ts",
      exposure_type: "search_result",
      reason: "rental_search:auth",
      redaction_count: 2,
      secret_scan_status: "redacted",
      requested_by: "acct_provider",
      approved_by: null,
      scope_id: "rwm_1",
      created_at: "2026-07-07T09:00:00.000Z",
    });
    assert.ok(exposure);
    assert.equal(exposure!.sessionId, "rsess_1");
    assert.equal(exposure!.path, "src/index.ts");
    assert.equal(exposure!.exposureType, "search_result");
    assert.equal(exposure!.redactionCount, 2);
    assert.equal(exposure!.secretScanStatus, "redacted");
    assert.equal(exposure!.createdAt, "2026-07-07T09:00:00.000Z");
  });

  it("coerces unknown enums to safe defaults and drops rows without id/path", () => {
    const exposure = mapApiExposure({
      id: "rexpo_2",
      path: "a.txt",
      exposure_type: "mystery",
      secret_scan_status: "mystery",
    });
    assert.equal(exposure!.exposureType, "file");
    assert.equal(exposure!.secretScanStatus, "passed");
    assert.equal(mapApiExposure({ id: "rexpo_3" }), null);
    assert.equal(mapApiExposure("nope"), null);
  });

  it("maps arrays and envelopes", () => {
    const rows = [{ id: "rexpo_1", path: "a.txt" }, { bad: true }];
    assert.equal(mapApiExposureArray(rows).length, 1);
    assert.equal(mapApiExposureArray({ exposures: rows }).length, 1);
    assert.equal(mapApiExposureArray(null).length, 0);
  });
});

// ---------------------------------------------------------------------------
// mapApiContextApproval
// ---------------------------------------------------------------------------

describe("mapApiContextApproval", () => {
  it("maps a rental_context_requests row into the desktop approval shape", () => {
    const approval = mapApiContextApproval({
      id: "rctxr_1",
      session_id: "rsess_1",
      path: "docs/spec.md",
      request_type: "read_file",
      status: "pending",
      reason: "need the spec",
      requested_by: "acct_provider",
      decided_by: null,
      created_at: "2026-07-07T09:00:00.000Z",
      decided_at: null,
    });
    assert.ok(approval);
    assert.equal(approval!.id, "rctxr_1");
    assert.equal(approval!.status, "pending");
    assert.equal(approval!.path, "docs/spec.md");
    assert.equal(approval!.reason, "need the spec");
    assert.equal(approval!.decidedAt, null);
  });

  it("unwraps decision envelopes ({ request, materialized })", () => {
    const approval = mapApiContextApproval({
      request: {
        id: "rctxr_2",
        session_id: "rsess_1",
        path: "a.txt",
        status: "approved",
        decided_by: "acct_renter",
        decided_at: "2026-07-07T10:00:00.000Z",
      },
      materialized: true,
    });
    assert.ok(approval);
    assert.equal(approval!.status, "approved");
    assert.equal(approval!.decidedBy, "acct_renter");
    assert.equal(approval!.materialized, true);
  });

  it("leaves materialized null on bare list rows", () => {
    const approval = mapApiContextApproval({ id: "rctxr_4", status: "approved" });
    assert.equal(approval!.materialized, null);
  });

  it("coerces unknown status to pending and maps arrays", () => {
    assert.equal(
      mapApiContextApproval({ id: "rctxr_3", status: "mystery" })!.status,
      "pending",
    );
    assert.equal(mapApiContextApprovalArray([{ id: "a" }, {}]).length, 1);
    assert.equal(
      mapApiContextApprovalArray({ requests: [{ id: "a" }] }).length,
      1,
    );
  });
});
