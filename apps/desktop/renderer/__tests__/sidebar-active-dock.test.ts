import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sidebarActiveRowEdge, sidebarRowFullyVisible } from "../src/domain/sidebar-active-dock";

const list = { top: 100, bottom: 500 };

describe("sidebar active room dock", () => {
  it("stays away while the open room's row shows", () => {
    assert.equal(sidebarActiveRowEdge({ top: 200, bottom: 236 }, list), null);
    // 60% of a 36 px row still shows at the bottom edge.
    assert.equal(sidebarActiveRowEdge({ top: 478, bottom: 514 }, list), null);
  });

  it("waits at the edge the row left by", () => {
    assert.equal(sidebarActiveRowEdge({ top: 40, bottom: 76 }, list), "top");
    // Only 6 px of the row shows under the top edge.
    assert.equal(sidebarActiveRowEdge({ top: 70, bottom: 106 }, list), "top");
    // 26 of 36 px still show: that is enough, so no dock yet.
    assert.equal(sidebarActiveRowEdge({ top: 90, bottom: 126 }, list), null);
    assert.equal(sidebarActiveRowEdge({ top: 600, bottom: 636 }, list), "bottom");
    assert.equal(sidebarActiveRowEdge({ top: 490, bottom: 526 }, list), "bottom");
  });

  it("ignores a row with no height, such as one inside a closing group", () => {
    assert.equal(sidebarActiveRowEdge({ top: 600, bottom: 600 }, list), null);
  });

  it("treats only a row wholly inside the list as visible", () => {
    assert.equal(sidebarRowFullyVisible({ top: 100, bottom: 136 }, list), true);
    assert.equal(sidebarRowFullyVisible({ top: 90, bottom: 126 }, list), false);
    assert.equal(sidebarRowFullyVisible({ top: 480, bottom: 516 }, list), false);
  });
});
