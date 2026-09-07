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
const motionStyles = readFileSync(fileURLToPath(new URL(
  "../src/styles/app-shell/motion.css",
  import.meta.url,
)), "utf8");

const switcherSource = readFileSync(fileURLToPath(new URL(
  "../src/components/desktop/sidebar/SidebarRoomSwitcher.vue",
  import.meta.url,
)), "utf8");

describe("desktop sidebar search contract", () => {
  it("keeps focus on the combobox and only exposes a rendered popup", () => {
    assert.match(sidebarSource, /:aria-controls="searchResults\.length \? 'sidebar-room-search-results' : undefined"/);
    assert.match(sidebarSource, /:aria-expanded="Boolean\(searchResults\.length\)"/);
    assert.match(sidebarSource, /role="option"\s+tabindex="-1"/);
  });

  it("keeps switcher options out of the dialog shell's button focus trap", () => {
    assert.match(switcherSource, /<div\s+v-for="\(option, index\) in options"[\s\S]*?role="option"\s+tabindex="-1"/);
    assert.match(switcherSource, /@keydown.down.prevent="move\(1\)"/);
    assert.match(switcherSource, /@keydown.enter.prevent="chooseActive"/);
    assert.match(switcherSource, /<DesktopDialogShell[\s\S]*?initial-focus="#sidebar-switcher-query"/);
  });

  it("swaps search and navigation immediately in the same grid row", () => {
    assert.match(sidebarSource, /v-else class="sidebar-navigation"/);
    assert.match(sidebarStyles, /\.sidebar-room-search\s*\{[\s\S]*?grid-row: 2;/);
    assert.match(sidebarStyles, /\.sidebar-navigation\s*\{[\s\S]*?grid-row: 2;/);
    assert.match(sidebarStyles, /\.sidebar-footer\s*\{[\s\S]*?grid-row: 3;/);
    assert.doesNotMatch(sidebarSource, /<Transition name="sidebar-navigation-swap"/);
    assert.doesNotMatch(sidebarSource, /<Transition name="sidebar-search-icon"/);
    assert.doesNotMatch(motionStyles, /\.sidebar-navigation-swap/);
    assert.doesNotMatch(motionStyles, /\.sidebar-search-icon/);
  });
});
