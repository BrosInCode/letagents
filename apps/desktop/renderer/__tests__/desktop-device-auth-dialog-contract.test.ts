import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const dialogSource = readFileSync(
  join(testDirectory, "../src/components/desktop/content/DesktopDeviceAuthDialog.vue"),
  "utf8",
);
const appSource = readFileSync(join(testDirectory, "../src/App.vue"), "utf8");
const authFlowSource = readFileSync(
  join(testDirectory, "../src/composables/useDesktopAuthFlow.ts"),
  "utf8",
);

test("normal desktop auth renders the GitHub device code before sending the user to GitHub", () => {
  assert.match(dialogSource, /data-testid="desktop-auth-device-code"/);
  assert.match(dialogSource, /\{\{ pendingAuth\.userCode \}\}/);
  assert.match(dialogSource, /data-testid="desktop-auth-copy-code"/);
  assert.match(dialogSource, /data-testid="desktop-auth-open-github"/);
  assert.match(dialogSource, /data-testid="desktop-auth-check-now"/);
  assert.match(dialogSource, /data-testid="desktop-auth-request-code"/);
  assert.match(dialogSource, /aria-labelledby="desktop-device-auth-title"/);
});

test("sidebar and settings share a resumable account auth dialog", () => {
  assert.match(appSource, /<DesktopDeviceAuthDialog/);
  assert.match(appSource, /@connect-account="openAccountAuthFlow"/);
  assert.match(appSource, /@start-auth="openAccountAuthFlow"/);
  assert.match(appSource, /if \(authStatus\.value\?\.pendingDeviceAuth\) \{\s+scheduleAuthPoll\(\);\s+return;/);
  assert.doesNotMatch(authFlowSource, /openVerification\(result\.pendingDeviceAuth\.verificationUri\)/);
  assert.match(authFlowSource, /Your code is ready/);
});
