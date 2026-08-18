import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(join(testDirectory, "../src/App.vue"), "utf8");
const signedOutSource = readFileSync(
  join(testDirectory, "../src/components/desktop/content/DesktopSignedOutView.vue"),
  "utf8",
);
const shellLayoutSource = readFileSync(join(testDirectory, "../src/styles/app-shell/layout.css"), "utf8");

test("desktop fails closed before mounting its room shell", () => {
  assert.match(appSource, /v-else-if="showSignedOutGate"/);
  assert.match(appSource, /authSessionLocked\.value \|\| !authStatus\.value\?\.authenticated/);
  assert.match(appSource, /<DesktopSignedOutView[\s\S]*?<main\s+v-else\s+class="desktop-shell"/);
  assert.match(appSource, /onSigningOut: clearDesktopSessionState/);
  assert.match(appSource, /rootRoomSnapshot\.value = null/);
  assert.match(appSource, /selectedSnapshot\.value = null/);
  assert.match(appSource, /syncSelectedRoomStream\(null\)/);
});

test("signed-out surface owns the complete GitHub device flow without room chrome", () => {
  assert.match(signedOutSource, /data-testid="desktop-signed-out-view"/);
  assert.match(signedOutSource, /data-testid="signed-out-start-auth"/);
  assert.match(signedOutSource, /data-testid="signed-out-device-code"/);
  assert.match(signedOutSource, /data-testid="signed-out-open-github"/);
  assert.match(signedOutSource, /data-testid="signed-out-check-now"/);
  assert.match(signedOutSource, /aria-live="polite"/);
  assert.match(signedOutSource, /GitHub device code copied/);
  assert.doesNotMatch(signedOutSource, /DesktopSidebar|DesktopRoomShell/);
});

test("signed-out surface stays monochrome in every device-flow state", () => {
  assert.match(shellLayoutSource, /\.desktop-onboarding-shell\.desktop-signed-out-shell\s*{[\s\S]*?--setup-bg: #000000;/);
  assert.match(shellLayoutSource, /\.desktop-onboarding-shell\.desktop-signed-out-shell\s*{[\s\S]*?--setup-accent: #ffffff;/);
  assert.match(signedOutSource, /\.signed-out-network\s*{[\s\S]*?color: var\(--text\);/);
  assert.match(signedOutSource, /\.signed-out-code\s*{[\s\S]*?var\(--text\)/);
  assert.doesNotMatch(signedOutSource, /var\(--setup-accent\)|var\(--green\)|radial-gradient/);
  assert.doesNotMatch(signedOutSource, /Signed-out mode|privacy boundary|personal access token|rooms stay out of sight/i);
});
