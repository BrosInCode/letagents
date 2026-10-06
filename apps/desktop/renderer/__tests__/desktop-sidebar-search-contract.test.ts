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

  it("teleports room switcher dialog to body so inert or hidden ancestors cannot block it", () => {
    assert.match(switcherSource, /<template>\s*<Teleport to="body">[\s\S]*?<DesktopDialogShell/);
    assert.match(switcherSource, /<\/DesktopDialogShell>\s*<\/Teleport>\s*<\/template>/);
  });

  it("renders the Zen Mode stays on caption only when zenMode is active", () => {
    assert.match(switcherSource, /<span v-if="zenMode"><Focus aria-hidden="true" \/>Zen Mode stays on<\/span>/);
    assert.match(sidebarSource, /<SidebarRoomSwitcher[\s\S]*?:zen-mode="zenMode"/);
    assert.match(sidebarSource, /:active-project-id="zenMode \? zenProject\?\.id \|\| null : null"/);
  });

  it("eliminates entrance and leave animation for the switcher without !important", () => {
    assert.match(switcherSource, /\.sidebar-switcher-backdrop\.desktop-dialog-enter-active,\s*\.sidebar-switcher-backdrop\.desktop-dialog-leave-active\s*\{[\s\S]*?transition:\s*none;/);
    assert.match(switcherSource, /\.sidebar-switcher-backdrop\.desktop-dialog-enter-active > \[role="dialog"\],\s*\.sidebar-switcher-backdrop\.desktop-dialog-leave-active > \[role="dialog"\]\s*\{[\s\S]*?transition:\s*none;/);
    assert.match(switcherSource, /\.sidebar-switcher-backdrop\.desktop-dialog-enter-from,\s*\.sidebar-switcher-backdrop\.desktop-dialog-leave-to\s*\{[\s\S]*?opacity:\s*1;/);
    assert.match(switcherSource, /\.sidebar-switcher-backdrop\.desktop-dialog-enter-from > \[role="dialog"\],\s*\.sidebar-switcher-backdrop\.desktop-dialog-leave-to > \[role="dialog"\]\s*\{[\s\S]*?opacity:\s*1;[\s\S]*?transform:\s*none;/);
    assert.doesNotMatch(switcherSource, /transition:\s*none\s*!important/);
  });

  it("makes shortcut discoverable on sidebar search control with correct mode-aware titles and ARIA keyshortcuts", () => {
    assert.match(sidebarSource, /:title="zenMode \? `Switch rooms \(\$\{switchShortcutLabel\}\)` : \(searchOpen \? 'Close room search' : `Search rooms \(\$\{switchShortcutLabel\} switches rooms\)`\)"/);
    assert.match(sidebarSource, /:aria-keyshortcuts="zenMode \? switchAriaKeyShortcuts : undefined"/);
  });

  it("delegates shortcut handling to canOpenRoomSwitcher predicate with lazy modal evaluation", () => {
    assert.match(sidebarSource, /canOpenRoomSwitcher\(\s*\{[\s\S]*?event,[\s\S]*?hasOpenModal:\s*\(\)\s*=>\s*Boolean\(document\.querySelector\('\[role="dialog"\]\[aria-modal="true"\]'\)\),[\s\S]*?isSwitcherOpen:\s*switcherOpen\.value,[\s\S]*?\}\)/);
  });
});
