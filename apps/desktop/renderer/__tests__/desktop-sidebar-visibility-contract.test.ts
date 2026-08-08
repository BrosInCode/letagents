import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const appSource = source("../src/App.vue");
const navigationSource = source("../src/composables/useDesktopNavigationState.ts");
const sidebarSource = source("../src/components/desktop/sidebar/DesktopSidebar.vue");
const typesSource = source("../src/components/desktop/types.ts");

describe("desktop sidebar visibility contract", () => {
  it("toggles directly between visible and hidden states", () => {
    assert.match(typesSource, /SidebarMode = "expanded" \| "hidden"/);
    assert.match(
      navigationSource,
      /sidebarMode\.value = sidebarMode\.value === "expanded" \? "hidden" : "expanded"/,
    );
    assert.doesNotMatch(navigationSource, /"rail"/);
    assert.doesNotMatch(sidebarSource, /sidebar-rail|sidebar-collapsed-actions/);
  });

  it("keeps the hidden state stable until the user asks to show it", () => {
    assert.doesNotMatch(appSource, /sidebar-peek-zone|sidebar-peek-panel|openSidebarPeek/);
    assert.match(sidebarSource, /aria-label="Hide sidebar"/);
  });
});
