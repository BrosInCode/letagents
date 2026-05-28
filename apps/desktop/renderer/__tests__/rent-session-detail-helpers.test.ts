import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DesktopRentalPatch } from "../../electron/ipc-types";
import {
  canApprovePatch,
  canCancelSessionStatus,
  canRequestPatchChanges,
  formatTime,
  patchCheckState,
  patchState,
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
});
