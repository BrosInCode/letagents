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
const sidebarRoomStyles = readFileSync(fileURLToPath(new URL(
  "../src/styles/app-shell/sidebar-rooms.css",
  import.meta.url,
)), "utf8");

describe("desktop sidebar overflow contract", () => {
  it("keeps the new-room action outside the bounded room sections", () => {
    assert.match(
      sidebarSource,
      /class="sidebar-actions"[\s\S]*?class="sidebar-cta"[\s\S]*?<\/div>\s*<div class="sidebar-room-sections"/,
    );
    assert.match(sidebarStyles, /\.sidebar-navigation\s*\{[\s\S]*?grid-template-rows: auto minmax\(0, 1fr\);/);
    assert.match(sidebarStyles, /\.sidebar-room-sections\s*\{[\s\S]*?min-height: 0;[\s\S]*?overflow: hidden;/);
    assert.match(
      sidebarSource,
      /class="sidebar-navigation"\s+@contextmenu\.prevent="openBackgroundContextMenu"/,
    );
  });

  it("gives large pinned groups their own bounded scroll area", () => {
    assert.match(sidebarRoomStyles, /\.project-list,\s*\.pinned-list\s*\{[\s\S]*?overflow-y: auto;/);
    assert.match(sidebarRoomStyles, /\.sidebar-pinned-section\s*\{[\s\S]*?max-height: 50%;[\s\S]*?overflow: hidden;/);
    assert.match(
      sidebarRoomStyles,
      /\.sidebar-room-sections:has\([\s\S]*?> \.sidebar-section\[data-empty="true"\][\s\S]*?\) > \.sidebar-pinned-section\s*\{\s*max-height: 100%;/,
    );
    assert.match(sidebarSource, /class="sidebar-section"\s+:data-empty="!roomProjectEntries\.length"/);
  });

  it("preserves focus and reduced-motion behavior in the pinned scroller", () => {
    assert.match(
      sidebarRoomStyles,
      /\.pinned-list \.pinned-room:focus-visible,[\s\S]*?\.pinned-list \.project-toggle:focus-visible\s*\{\s*outline-offset: -2px;/,
    );
    assert.match(
      sidebarStyles,
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.project-list,\s*\.pinned-list\s*\{\s*transition: none;/,
    );
  });
});
