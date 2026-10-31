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
    assert.match(sidebarStyles, /\.sidebar-room-sections\s*\{[^}]*min-height: 0;[^}]*overflow-y: auto;/);
    assert.match(
      sidebarSource,
      /class="sidebar-navigation"\s+@contextmenu\.prevent="openBackgroundContextMenu"/,
    );
  });

  it("scrolls pinned rooms and rooms together, so neither is clipped in a box of its own", () => {
    const lists = /\.project-list,\s*\.pinned-list\s*\{([^}]*)\}/.exec(sidebarRoomStyles)?.[1] ?? "";
    assert.ok(lists, "the room lists have a rule");
    assert.doesNotMatch(lists, /overflow-y: auto|mask-image/, "a list never scrolls or fades on its own");
    const pinned = /\.sidebar-pinned-section\s*\{([^}]*)\}/.exec(sidebarRoomStyles)?.[1] ?? "";
    assert.doesNotMatch(pinned, /max-height/, "pinned rooms are never capped to part of the sidebar");
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

  it("removes press displacement from selection controls under reduced motion", () => {
    assert.match(
      sidebarStyles,
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.sidebar-topbar-action:not\(:disabled\):active,[\s\S]*?\.sidebar-selection-scope:not\(:disabled\):active,[\s\S]*?\.sidebar-selection-toolbar button:not\(:disabled\):active\s*\{\s*transform: none;/,
    );
  });

  it("associates each overflow disclosure with the controlled room list", () => {
    const overflowToggles = sidebarSource.match(
      /class="project-room-overflow-toggle"[\s\S]*?:aria-controls="projectChildListId\(project\.id\)"/g,
    ) || [];
    assert.equal(overflowToggles.length, 2);
  });
});
