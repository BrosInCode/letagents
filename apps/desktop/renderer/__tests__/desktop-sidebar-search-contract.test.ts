import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const sidebarSource = readFileSync(fileURLToPath(new URL(
  "../src/components/desktop/sidebar/DesktopSidebar.vue",
  import.meta.url,
)), "utf8");
const sidebarStyles = readFileSync(fileURLToPath(new URL(
  "../src/styles/app-shell/sidebar.css",
  import.meta.url,
)), "utf8");

describe("desktop sidebar search contract", () => {
  it("keeps focus on the combobox and only exposes a rendered popup", () => {
    assert.match(sidebarSource, /:aria-controls="searchResults\.length \? 'sidebar-room-search-results' : undefined"/);
    assert.match(sidebarSource, /:aria-expanded="Boolean\(searchResults\.length\)"/);
    assert.match(sidebarSource, /role="option"\s+tabindex="-1"/);
  });

  it("swaps search and navigation in the same grid row", () => {
    assert.match(sidebarSource, /<Transition name="sidebar-navigation-swap">/);
    assert.match(sidebarSource, /v-else-if="sidebarMode === 'expanded'" class="sidebar-navigation"/);
    assert.match(sidebarStyles, /\.sidebar-room-search\s*\{[\s\S]*?grid-row: 2;/);
    assert.match(sidebarStyles, /\.sidebar-navigation\s*\{[\s\S]*?grid-row: 2;/);
    assert.match(sidebarStyles, /\.sidebar-footer\s*\{[\s\S]*?grid-row: 3;/);
  });
});
