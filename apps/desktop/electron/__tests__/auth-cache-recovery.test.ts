import assert from "node:assert/strict";
import { mkdirSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createElectronTestEnv, installTestSecretStorage, testEncryptedToken } from "./harness.js";

// Runs in its own process (node --test spawns one per file), so auth.js's
// module-level cache starts cold here — required to exercise the very first
// readStoredAuth failing.
installTestSecretStorage();
const env = createElectronTestEnv({
  prefix: "letagents-auth-cache-recovery-",
  paths: [],
  extraCleanupEnvKeys: ["LETAGENTS_DESKTOP_USER_DATA_DIR"],
});
process.env.LETAGENTS_DESKTOP_USER_DATA_DIR = env.tempDir;

const authStorePath = join(env.tempDir, "letagents-desktop-auth.json");

const { apiFetch, clearStoredAuth, readStoredAuth } = await import("../main/auth.js");

test("auth cache: a transient non-ENOENT read failure is not cached", async () => {
  const previous = globalThis.fetch;
  const authHeaders: Array<string | null> = [];
  const stub = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    authHeaders.push(new Headers(init?.headers).get("Authorization"));
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = stub;

  try {
    // Force a non-ENOENT read failure (EISDIR): the auth store path is a
    // directory, simulating a transient disk/permission hiccup at startup.
    mkdirSync(authStorePath);
    await apiFetch("/during-failure");
    assert.equal(
      authHeaders[0],
      null,
      "a failed read must degrade to signed-out for this request",
    );

    // Clear the failure and seed a valid auth file. If the failed read had
    // been cached, this token would never be picked up until restart.
    rmdirSync(authStorePath);
    writeFileSync(
      authStorePath,
      `${JSON.stringify(
        {
    version: 2,
  ownerTokenId: null,
          oauthTokenExpiresAt: null,
          account: null,
          pendingDeviceAuth: null,
          savedAt: new Date().toISOString(),
          encryptedToken: testEncryptedToken("token-recovered"),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await apiFetch("/after-recovery");
    assert.equal(
      authHeaders[1],
      "Bearer token-recovered",
      "the next read must retry the disk and self-heal (failure not cached)",
    );
  } finally {
    if (globalThis.fetch === stub) globalThis.fetch = previous;
  }
});


test("legacy owner credentials are never promoted into an app session", async () => {
  await clearStoredAuth();
  writeFileSync(authStorePath, JSON.stringify({ encryptedToken: testEncryptedToken("old-owner"), account: { id: "old-account" } }));
  const auth = await readStoredAuth();
  assert.equal(auth.token, null);
  assert.equal(auth.agentToken, null);
  assert.equal(auth.account, null);
});
