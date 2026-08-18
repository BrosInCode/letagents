import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createElectronTestEnv } from "./harness.js";

const env = createElectronTestEnv({
  prefix: "letagents-auth-device-cancel-",
  paths: [],
  extraCleanupEnvKeys: ["LETAGENTS_DESKTOP_USER_DATA_DIR"],
});
process.env.LETAGENTS_DESKTOP_USER_DATA_DIR = env.tempDir;

const authStorePath = join(env.tempDir, "letagents-desktop-auth.json");
writeFileSync(authStorePath, `${JSON.stringify({
  ownerTokenId: null,
  oauthTokenExpiresAt: null,
  account: null,
  pendingDeviceAuth: {
    requestId: "request-1",
    userCode: "ABCD-1234",
    verificationUri: "https://github.com/login/device",
    expiresAt: "2026-08-16T12:00:00.000Z",
    intervalSeconds: 5,
    roomIdentifier: null,
    startedAt: "2026-08-16T11:45:00.000Z",
  },
  savedAt: new Date().toISOString(),
  encryptedToken: null,
}, null, 2)}\n`, "utf8");

const { cancelDeviceAuthFlow, readStoredAuth } = await import("../main/auth.js");

test("canceling device auth clears the persisted pending request", async () => {
  const status = await cancelDeviceAuthFlow();
  const stored = await readStoredAuth();

  assert.equal(status.authenticated, false);
  assert.equal(status.pendingDeviceAuth, null);
  assert.equal(stored.pendingDeviceAuth, null);
});
