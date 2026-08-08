import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const appSource = source("../src/App.vue");
const authOnboardingSource = source("../src/components/desktop/content/AuthOnboardingView.vue");
const navigationSource = source("../src/composables/useDesktopNavigationState.ts");
const sidebarSource = source("../src/components/desktop/sidebar/DesktopSidebar.vue");
const typesSource = source("../src/components/desktop/types.ts");
const layoutSource = source("../src/styles/app-shell/layout.css");
const motionSource = source("../src/styles/app-shell/motion.css");

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

  it("moves focus to the reveal control when the sidebar becomes inert", () => {
    assert.match(appSource, /const hidingSidebar = sidebarMode\.value !== "hidden"/);
    assert.match(appSource, /await nextTick\(\)/);
    assert.match(
      appSource,
      /\[data-testid="room-sidebar-reveal-button"\][\s\S]*?\[data-testid="auth-sidebar-reveal-button"\][\s\S]*?\[data-testid="sidebar-reveal-button"\][\s\S]*?\.focus\(\{ preventScroll: true \}\)/,
    );
    assert.match(appSource, /<AuthOnboardingView[\s\S]*?:sidebar-mode="sidebarMode"[\s\S]*?@cycle-sidebar="cycleSidebar"/);
    assert.match(authOnboardingSource, /data-testid="auth-sidebar-reveal-button"/);
  });

  it("animates the sidebar and its layout as one interruptible transition", () => {
    assert.match(appSource, /<Transition name="desktop-sidebar">/);
    assert.match(appSource, /v-show="!isSettingsSurface && sidebarMode !== 'hidden'"/);
    assert.match(appSource, /:inert="isSettingsSurface \|\| sidebarMode === 'hidden'"/);
    assert.match(layoutSource, /grid-template-columns: var\(--sidebar-track-width\) minmax\(0, 1fr\)/);
    assert.match(
      layoutSource,
      /\.desktop-shell\[data-sidebar-mode="hidden"\][^{]*\{[^}]*--sidebar-track-width: 0px;[^}]*transition-duration: 160ms;/s,
    );
    assert.match(motionSource, /\.desktop-sidebar-enter-active/);
    assert.match(motionSource, /\.desktop-sidebar-leave-active/);
    assert.doesNotMatch(`${layoutSource}\n${motionSource}`, /transition:\s*all\b/);
  });

  it("removes sidebar displacement when reduced motion is requested", () => {
    assert.match(
      layoutSource,
      /@media \(prefers-reduced-motion: reduce\)[^{]*\{[\s\S]*?\.desktop-shell\s*\{\s*transition: none;/,
    );
    assert.match(
      motionSource,
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.desktop-sidebar-enter-from,[\s\S]*?transform: none;/,
    );
  });
});
