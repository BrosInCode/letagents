import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const componentSource = readFileSync(
  join(testDirectory, "../src/components/desktop/sidebar/SidebarAccountMenu.vue"),
  "utf8",
);
const sidebarSource = readFileSync(
  join(testDirectory, "../src/components/desktop/sidebar/DesktopSidebar.vue"),
  "utf8",
);
const appSource = readFileSync(join(testDirectory, "../src/App.vue"), "utf8");

test("sidebar exposes an accessible account menu with functional auth actions", () => {
  assert.match(componentSource, /aria-haspopup="menu"/);
  assert.match(componentSource, /:aria-expanded="open"/);
  assert.match(componentSource, /role="menu"/);
  assert.match(componentSource, /data-testid="sidebar-account-logout"/);
  assert.match(componentSource, /data-testid="sidebar-account-connect"/);
  assert.match(componentSource, /document\.addEventListener\("pointerdown"/);
  assert.match(componentSource, /@keydown\.esc\.stop\.prevent/);
  assert.match(sidebarSource, /<SidebarAccountMenu/);
  assert.match(sidebarSource, /@sign-out="\$emit\('sign-out'\)"/);
  assert.match(appSource, /@sign-out="signOut"/);
  assert.match(appSource, /@connect-account="startAuthFlow"/);
});
