import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { APP_IDLE_ATTRIBUTE, isAppIdle } from "../src/domain/app-idle";

describe("isAppIdle", () => {
  it("is not idle only while the window is both visible and focused", () => {
    assert.equal(isAppIdle({ hidden: false, focused: true }), false);
  });

  it("is idle while the window is hidden", () => {
    assert.equal(isAppIdle({ hidden: true, focused: true }), true);
    assert.equal(isAppIdle({ hidden: true, focused: false }), true);
  });

  it("is idle while the window is blurred, even when visible", () => {
    // Pausing on blur (not just hidden) is the deliberate battery choice.
    assert.equal(isAppIdle({ hidden: false, focused: false }), true);
  });

  it("exposes the document-root attribute name CSS scopes the paused state to", () => {
    assert.equal(APP_IDLE_ATTRIBUTE, "data-app-idle");
  });
});
