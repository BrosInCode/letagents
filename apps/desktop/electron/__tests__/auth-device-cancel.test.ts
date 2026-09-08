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

const { startDeviceAuthFlow, pollDeviceAuthFlow, signOutDesktopAuth, setAuthAuthorizedHandler } = await import("../main/auth.js");

for (const action of ["cancel", "signOut", "restart"] as const) {
  test(`late authorized response cannot persist credentials after ${action}`, async () => {
    const originalFetch = globalThis.fetch;
    let finishPoll!: (value: Response) => void;
    let pollStarted!: () => void;
    const started = new Promise<void>(resolve => { pollStarted = resolve; });
    let request = 0;
    let authorizedCount = 0;
    setAuthAuthorizedHandler(() => { authorizedCount += 1; });
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("/auth/device/start")) return Response.json({
        request_id: `request-${++request}`, user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device", expires_in: 600, interval: 5,
      });
      if (url.includes("/auth/device/poll/")) {
        pollStarted();
        return new Promise(resolve => { finishPoll = resolve; });
      }
      return Response.json({ success: true });
    };
    try {
      await startDeviceAuthFlow();
      const poll = pollDeviceAuthFlow();
      await started;
      if (action === "cancel") await cancelDeviceAuthFlow();
      if (action === "signOut") await signOutDesktopAuth();
      if (action === "restart") await startDeviceAuthFlow();
      finishPoll(Response.json({
        status: "authorized", letagents_token: "late-test-token",
        account: { id: "test", provider: "github", provider_user_id: "test", login: "test" },
      }));
      assert.notEqual((await poll).status, "authorized");
      assert.equal((await readStoredAuth()).token, null);
      assert.equal(authorizedCount, 0);
      assert.equal((await readStoredAuth()).pendingDeviceAuth?.requestId ?? null,
        action === "restart" ? "request-2" : null);
    } finally {
      globalThis.fetch = originalFetch;
      await cancelDeviceAuthFlow();
    }
  });
}

test("cancel during device-code startup does not persist the late code", async () => {
  const originalFetch = globalThis.fetch;
  let finishStart!: (value: Response) => void;
  let fetchStarted!: () => void;
  const started = new Promise<void>(resolve => { fetchStarted = resolve; });
  globalThis.fetch = async () => {
    fetchStarted();
    return new Promise(resolve => { finishStart = resolve; });
  };
  try {
    const start = startDeviceAuthFlow();
    await started;
    await cancelDeviceAuthFlow();
    finishStart(Response.json({ request_id: "late", user_code: "LATE", verification_uri: "https://github.com/login/device", expires_in: 600, interval: 5 }));
    await start;
    assert.equal((await readStoredAuth()).pendingDeviceAuth, null);
  } finally { globalThis.fetch = originalFetch; }
});
