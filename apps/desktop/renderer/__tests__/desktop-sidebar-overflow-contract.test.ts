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
  });

  it("gives large pinned groups their own bounded scroll area", () => {
    assert.match(sidebarRoomStyles, /\.project-list,\s*\.pinned-list\s*\{[\s\S]*?overflow-y: auto;/);
    assert.match(sidebarRoomStyles, /\.sidebar-pinned-section\s*\{[\s\S]*?max-height: 50%;[\s\S]*?overflow: hidden;/);
    assert.match(
      sidebarRoomStyles,
      /\.sidebar-room-sections:has\(> \.sidebar-section > \.sidebar-section-header\[data-collapsed="true"\]\)\s*> \.sidebar-pinned-section\s*\{\s*max-height: 100%;/,
    );
  });
});
