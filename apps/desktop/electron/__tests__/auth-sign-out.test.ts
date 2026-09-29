import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createElectronTestEnv, installTestSecretStorage, testEncryptedToken } from "./harness.js";

installTestSecretStorage();
const env = createElectronTestEnv({
  prefix: "letagents-auth-sign-out-",
  paths: [],
  extraCleanupEnvKeys: ["LETAGENTS_DESKTOP_USER_DATA_DIR"],
});
process.env.LETAGENTS_DESKTOP_USER_DATA_DIR = env.tempDir;

const authStorePath = join(env.tempDir, "letagents-desktop-auth.json");
writeFileSync(authStorePath, `${JSON.stringify({
  version: 2,
  ownerTokenId: "owner-token-1",
  oauthTokenExpiresAt: null,
  account: {
    id: "account-1",
    provider: "github",
    providerUserId: "github-1",
    login: "octocat",
    displayName: "Octocat",
    avatarUrl: null,
  },
  pendingDeviceAuth: null,
  savedAt: new Date().toISOString(),
  encryptedToken: testEncryptedToken("desktop-app-session"),
  encryptedAgentToken: testEncryptedToken("desktop-agent-token"),
}, null, 2)}\n`, "utf8");

const { readStoredAuth, signOutDesktopAuth } = await import("../main/auth.js");

test("desktop logout clears local credentials even when server revocation fails", async () => {
  const previous = globalThis.fetch;
  const authorizations: Array<string | null> = [];
  const stub = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    authorizations.push(new Headers(init?.headers).get("Authorization"));
    return new Response(JSON.stringify({ error: "offline" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = stub;

  try {
    await signOutDesktopAuth();
    const stored = await readStoredAuth();
    assert.deepEqual(authorizations.sort(), ["Bearer desktop-agent-token", "Bearer desktop-app-session"]);
    assert.equal(stored.agentToken, null);
    assert.equal(stored.token, null);
    assert.equal(stored.account, null);
    assert.equal(existsSync(authStorePath), false);
  } finally {
    if (globalThis.fetch === stub) globalThis.fetch = previous;
  }
});
