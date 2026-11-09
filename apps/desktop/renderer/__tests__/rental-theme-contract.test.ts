import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const marketplaceStyles = source("../src/styles/surfaces/rent-marketplace.css");
const reviewSheet = source("../src/components/desktop/content/RentRequestReviewSheet.vue");
const reviewStyles = source("../src/components/desktop/content/rent-request-review-sheet.css");
const settingsStyles = source("../src/components/desktop/settings/panes/settings-renting.css");
const segmentedControl = source("../src/components/desktop/controls/DesktopSegmentedControl.vue");

describe("Rent theme contract", () => {
  it("derives marketplace and modal materials from the shell palette", () => {
    assert.match(marketplaceStyles, /--rent-surface: var\(--bg-card\)/);
    assert.match(marketplaceStyles, /background: var\(--rent-surface\)/);
    assert.match(marketplaceStyles, /color: var\(--text\)/);
    assert.doesNotMatch(marketplaceStyles, /rgba\(20,\s*23,\s*28|#17191d|#dff5ff|#d8f3ff/);

    assert.match(reviewSheet, /<style scoped src="\.\/rent-request-review-sheet\.css"><\/style>/);
    assert.match(reviewStyles, /var\(--bg-elevated\)/);
    assert.match(reviewStyles, /var\(--text-secondary\)/);
    assert.doesNotMatch(reviewStyles, /rgba\(24,\s*27,\s*32|#181b20|#dff5ff/);
  });

  it("keeps provider settings and shared Rent chrome theme-relative", () => {
    assert.match(settingsStyles, /background: var\(--text\)/);
    assert.match(settingsStyles, /color: var\(--bg\)/);
    assert.doesNotMatch(settingsStyles, /rgba\(255,\s*255,\s*255|#(?:fff|ffffff)\b|#7dd3fc|#dff5ff|#d8f3ff/i);
    assert.match(settingsStyles, /@media \(prefers-contrast: more\)/);

    assert.match(segmentedControl, /background: var\(--accent-dim\)/);
    assert.match(segmentedControl, /background: var\(--accent-active\)/);
    assert.match(segmentedControl, /color: var\(--text\)/);
    assert.doesNotMatch(segmentedControl, /rgba\(255,\s*255,\s*255|#bfdbfe/);
  });
});
