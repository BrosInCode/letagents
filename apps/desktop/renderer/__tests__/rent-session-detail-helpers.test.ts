import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  DesktopRentalContextApproval,
  DesktopRentalPatch,
} from "../../electron/ipc-types";
import {
  canApprovePatch,
  canCancelSessionStatus,
  canRequestPatchChanges,
  contextRequestState,
  countPendingContextRequests,
  exposureScanState,
  exposureTypeLabel,
  formatTime,
  humanizeToken,
  patchCheckState,
  patchState,
  rentalContinuityLabel,
  rentalModeLabel,
  sessionStatusState,
} from "../src/components/desktop/content/rent-session-detail/presentation";

describe("rent session detail presentation helpers", () => {
  it("maps current rental session statuses to visible pill states", () => {
    assert.equal(sessionStatusState("active"), "active");
    assert.equal(sessionStatusState("completed"), "connected");
    assert.equal(sessionStatusState("failed"), "failed");
    assert.equal(sessionStatusState("requested"), "starting");
    assert.equal(sessionStatusState("cancelled"), "offline");
  });

  it("only shows cancel for statuses accepted by the session state machine", () => {
    assert.equal(canCancelSessionStatus("requested"), true);
    assert.equal(canCancelSessionStatus("active"), true);
    assert.equal(canCancelSessionStatus("budget_exhausted"), true);
    assert.equal(canCancelSessionStatus("provisioning"), false);
    assert.equal(canCancelSessionStatus("completed"), false);
  });

  it("maps patch and check states for the patch list", () => {
    assert.equal(patchState("passed"), "connected");
    assert.equal(patchState("needs_renter_approval"), "starting");
    assert.equal(patchState("timed_out"), "failed");
    assert.equal(patchCheckState("warning"), "starting");
    assert.equal(patchCheckState("skipped"), "offline");
  });

  it("keeps patch actions off patches that already have a PR", () => {
    const patch = {
      gateStatus: "passed",
      prUrl: null,
    } as DesktopRentalPatch;
    assert.equal(canApprovePatch(patch), true);
    assert.equal(canRequestPatchChanges(patch), true);

    patch.prUrl = "https://github.com/BrosInCode/letagents/pull/1";
    assert.equal(canApprovePatch(patch), false);
    assert.equal(canRequestPatchChanges(patch), false);
  });

  it("returns raw timestamps when the value cannot be parsed", () => {
    assert.equal(formatTime(null), "—");
    assert.equal(formatTime("not-a-date"), "not-a-date");
  });

  it("keeps rental labels human readable across surfaces", () => {
    assert.equal(humanizeToken("in_progress"), "In Progress");
    assert.equal(humanizeToken("budget-exhausted"), "Budget Exhausted");
    assert.equal(rentalModeLabel("trusted_open"), "Full workspace access");
    assert.equal(rentalModeLabel("scoped"), "Limited access");
    assert.equal(rentalContinuityLabel("full_transcript"), "Full room transcript");
    assert.equal(rentalContinuityLabel("smart_handoff"), "Summary only");
  });

  it("maps context request statuses to pill states", () => {
    assert.equal(contextRequestState("pending"), "starting");
    assert.equal(contextRequestState("approved"), "connected");
    assert.equal(contextRequestState("denied"), "failed");
    assert.equal(contextRequestState("expired"), "offline");
  });

  it("counts only pending context requests for the review banner", () => {
    const base: DesktopRentalContextApproval = {
      id: "rctxr_1",
      sessionId: "rsess_1",
      requestType: "read_file",
      status: "pending",
      path: "a.txt",
      reason: null,
      redactionCount: 0,
      requestedBy: null,
      decidedBy: null,
      createdAt: null,
      decidedAt: null,
      materialized: null,
    };
    const requests: DesktopRentalContextApproval[] = [
      base,
      { ...base, id: "rctxr_2", status: "approved" },
      { ...base, id: "rctxr_3", status: "denied" },
      { ...base, id: "rctxr_4" },
    ];
    assert.equal(countPendingContextRequests(requests), 2);
    assert.equal(countPendingContextRequests([]), 0);
  });

  it("maps exposure scan statuses and type labels", () => {
    assert.equal(exposureScanState("passed"), "connected");
    assert.equal(exposureScanState("redacted"), "starting");
    assert.equal(exposureScanState("blocked"), "failed");
    assert.equal(exposureTypeLabel("file"), "File read");
    assert.equal(exposureTypeLabel("search_result"), "Search result");
    assert.equal(exposureTypeLabel("command_output"), "Command output");
  });
});
