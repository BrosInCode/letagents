import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createElectronTestEnv, installTestSecretStorage, testEncryptedToken } from "./harness.js";

installTestSecretStorage();
const env = createElectronTestEnv({
  prefix: "letagents-auth-device-cancel-",
  paths: [],
  extraCleanupEnvKeys: ["LETAGENTS_DESKTOP_USER_DATA_DIR"],
});
process.env.LETAGENTS_DESKTOP_USER_DATA_DIR = env.tempDir;

const authStorePath = join(env.tempDir, "letagents-desktop-auth.json");
writeFileSync(authStorePath, `${JSON.stringify({
  version: 2,
  ownerTokenId: null,
  oauthTokenExpiresAt: null,
  account: null,
  pendingDeviceAuth: {
    requestId: "request-1",
    userCode: "ABCD-1234",
    verificationUri: "https://letagents.chat/auth/app/authorize/test",
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
      if (url.includes("/auth/app/start")) return Response.json({
        request_id: `request-${++request}`, user_code: "ABCD-1234",
        verification_uri: "https://letagents.chat/auth/app/authorize/test", expires_in: 600, interval: 5,
      });
      if (url.includes("/auth/app/exchange")) {
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
        status: "authorized", app_session: "late-test-token", agent_token: "late-agent-token",
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
    finishStart(Response.json({ request_id: "late", user_code: "LATE", verification_uri: "https://letagents.chat/auth/app/authorize/test", expires_in: 600, interval: 5 }));
    await start;
    assert.equal((await readStoredAuth()).pendingDeviceAuth, null);
  } finally { globalThis.fetch = originalFetch; }
});


test("manual and automatic checks share one exchange and authorize once", async () => {
  const originalFetch = globalThis.fetch;
  let exchanges = 0;
  let authorized = 0;
  let finish!: (response: Response) => void;
  let started!: () => void;
  const exchangeStarted = new Promise<void>(resolve => { started = resolve; });
  setAuthAuthorizedHandler(() => { authorized++; });
  globalThis.fetch = async input => {
    if (String(input).includes("/auth/app/start")) return Response.json({
      request_id: "shared-request", user_code: "ABCD1234", verification_uri: "https://letagents.chat/auth/app/authorize/test", expires_in: 600, interval: 2,
    });
    exchanges++;
    started();
    return new Promise(resolve => { finish = resolve; });
  };
  try {
    await startDeviceAuthFlow();
    const automatic = pollDeviceAuthFlow();
    await exchangeStarted;
    const manual = pollDeviceAuthFlow("shared-request");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(exchanges, 1);
    finish(Response.json({ status: "authorized", app_session: "app-test", agent_token: "agent-test",
      account: { id: "test", provider: "github", provider_user_id: "test", login: "test" } }));
    const results = await Promise.all([automatic, manual]);
    assert.deepEqual(results.map(result => result.status), ["authorized", "authorized"]);
    assert.equal(authorized, 1);
    assert.equal((await readStoredAuth()).token, "app-test");
  } finally {
    globalThis.fetch = originalFetch;
    setAuthAuthorizedHandler(() => undefined);
    await cancelDeviceAuthFlow();
  }
});

test("unchanged waiting responses never rewrite the encrypted auth store", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => Response.json(String(input).includes("/auth/app/start") ? {
    request_id: "waiting-request", user_code: "ABCD1234", verification_uri: "https://letagents.chat/auth/app/authorize/test", expires_in: 600, interval: 2,
  } : { status: "pending", interval: 2 });
  try {
    await startDeviceAuthFlow();
    const stored = await readStoredAuth();
    const file = readFileSync(authStorePath, "utf8");
    for (let i = 0; i < 3; i++) assert.equal((await pollDeviceAuthFlow()).status, "pending");
    assert.equal(await readStoredAuth(), stored);
    assert.equal(readFileSync(authStorePath, "utf8"), file);
  } finally {
    globalThis.fetch = originalFetch;
    await cancelDeviceAuthFlow();
  }
});

test("expired approval clears the code and verifier locally without a network exchange", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ request_id: "expired-request", user_code: "ABCD1234",
      verification_uri: "https://letagents.chat/auth/app/authorize/test", expires_in: -1, interval: 2 });
  };
  try {
    await startDeviceAuthFlow();
    assert.ok((await readStoredAuth()).appLoginVerifier);
    const result = await pollDeviceAuthFlow();
    assert.equal(result.status, "expired");
    assert.equal(result.authStatus.pendingDeviceAuth, null);
    assert.equal((await readStoredAuth()).appLoginVerifier, null);
    assert.equal(calls, 1);
    const disk = JSON.parse(readFileSync(authStorePath, "utf8"));
    assert.equal(disk.pendingDeviceAuth, null);
    assert.equal(disk.encryptedAppLoginVerifier, null);
  } finally {
    globalThis.fetch = originalFetch;
    await cancelDeviceAuthFlow();
  }
});
