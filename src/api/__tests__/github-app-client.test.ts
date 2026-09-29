import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test, { afterEach } from "node:test";

import type { GitHubAppConfig } from "../github/config.js";
import {
  clearGitHubInstallationTokenCache,
  mintInstallationToken,
  mintInstallationCredential,
} from "../github/app-client.js";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ format: "pem", type: "pkcs8" })
  .toString();
const config = {
  appId: "123",
  appSlug: "letagents",
  privateKey,
} as GitHubAppConfig;

afterEach(() => {
  clearGitHubInstallationTokenCache();
});

test("installation tokens are reused until shortly before GitHub expiry", async () => {
  const issuedAt = new Date("2026-08-10T00:00:00.000Z");
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return jsonResponse({
      token: `token-${calls}`,
      expires_at: "2026-08-10T01:00:00.000Z",
      permissions: { pull_requests: "write" },
    });
  }) as typeof fetch;

  const first = await mintInstallationToken({
    config,
    installationId: "installation-1",
    fetchImpl,
    now: issuedAt,
  });
  const cached = await mintInstallationToken({
    config,
    installationId: "installation-1",
    fetchImpl,
    now: new Date("2026-08-10T00:30:00.000Z"),
  });
  assert.equal(first, "token-1");
  assert.equal(cached, "token-1");
  assert.equal(calls, 1);
  assert.deepEqual(await mintInstallationCredential({ config, installationId: "installation-1", fetchImpl,
    now: new Date("2026-08-10T00:30:00.000Z") }), {
    token: "token-1", permissions: { pull_requests: "write" },
  });
  assert.equal(calls, 1, "token-only and permission-aware callers share the same cache");

  const refreshed = await mintInstallationToken({
    config,
    installationId: "installation-1",
    fetchImpl,
    now: new Date("2026-08-10T00:56:00.000Z"),
  });
  assert.equal(refreshed, "token-2");
  assert.equal(calls, 2, "the five-minute safety window forces a refresh");
});

test("concurrent installation-token requests share one mint", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fetchImpl = (async () => {
    calls += 1;
    await gate;
    return jsonResponse({
      token: "shared-token",
      expires_at: "2026-08-10T01:00:00.000Z",
    });
  }) as typeof fetch;
  const input = {
    config,
    installationId: "installation-2",
    fetchImpl,
    now: new Date("2026-08-10T00:00:00.000Z"),
  };

  const first = mintInstallationToken(input);
  const second = mintInstallationToken(input);
  release();
  assert.deepEqual(await Promise.all([first, second]), ["shared-token", "shared-token"]);
  assert.equal(calls, 1);
});

test("a bounded token caller does not join a longer-running mint", async () => {
  let calls = 0;
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const fetchImpl = (async () => {
    calls += 1;
    const call = calls;
    if (call === 1) await firstGate;
    return jsonResponse({
      token: `token-${call}`,
      expires_at: call === 1
        ? "2026-08-10T01:00:00.000Z"
        : "2026-08-10T02:00:00.000Z",
    });
  }) as typeof fetch;
  const common = {
    config,
    installationId: "installation-timeout-isolation",
    fetchImpl,
    now: new Date("2026-08-10T00:00:00.000Z"),
  };

  const longerMint = mintInstallationToken(common);
  const boundedMint = await mintInstallationToken({ ...common, timeoutMs: 25 });
  assert.equal(boundedMint, "token-2");
  assert.equal(calls, 2, "different timeout contracts use independent flights");

  releaseFirst();
  assert.equal(await longerMint, "token-1");
  assert.equal(await mintInstallationToken(common), "token-2", "later stale completion does not downgrade cache");
});

test("installation webhook invalidation prevents cached-token reuse", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return jsonResponse({
      token: `token-${calls}`,
      expires_at: "2026-08-10T01:00:00.000Z",
    });
  }) as typeof fetch;
  const input = {
    config,
    installationId: "installation-3",
    fetchImpl,
    now: new Date("2026-08-10T00:00:00.000Z"),
  };

  assert.equal(await mintInstallationToken(input), "token-1");
  clearGitHubInstallationTokenCache("installation-3");
  assert.equal(await mintInstallationToken(input), "token-2");
  assert.equal(calls, 2);
});

test("installation invalidation prevents an older in-flight mint from repopulating cache", async () => {
  let calls = 0;
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const fetchImpl = (async () => {
    calls += 1;
    if (calls === 1) await firstGate;
    return jsonResponse({
      token: `token-${calls}`,
      expires_at: "2026-08-10T01:00:00.000Z",
    });
  }) as typeof fetch;
  const input = {
    config,
    installationId: "installation-4",
    fetchImpl,
    now: new Date("2026-08-10T00:00:00.000Z"),
  };

  const staleMint = mintInstallationToken(input);
  clearGitHubInstallationTokenCache("installation-4");
  releaseFirst();
  assert.equal(await staleMint, "token-1");
  assert.equal(await mintInstallationToken(input), "token-2");
  assert.equal(calls, 2);
});

test("permission evidence follows its exact cached token and webhook invalidation", async () => {
  let calls = 0;
  const fetchImpl = (async () => jsonResponse({
    token: `permission-token-${++calls}`, expires_at: "2026-08-10T01:00:00.000Z",
    permissions: { pull_requests: calls === 1 ? "write" : "read" },
  })) as typeof fetch;
  const input = { config, installationId: "permission-change", fetchImpl, now: new Date("2026-08-10T00:00:00Z") };
  const [token, credential] = await Promise.all([mintInstallationToken(input), mintInstallationCredential(input)]);
  assert.equal(token, credential.token);
  assert.equal(credential.permissions?.pull_requests, "write");
  assert.equal(calls, 1);
  clearGitHubInstallationTokenCache(input.installationId);
  const changed = await mintInstallationCredential(input);
  assert.equal(changed.token, "permission-token-2");
  assert.equal(changed.permissions?.pull_requests, "read");
});

test("unknown token permissions remain explicit without blocking existing token-only readers", async () => {
  const input = { config, installationId: "unknown-permissions",
    fetchImpl: (async () => jsonResponse({ token: "read-token" })) as typeof fetch };
  assert.deepEqual(await mintInstallationCredential(input), { token: "read-token", permissions: null });
  assert.equal(await mintInstallationToken(input), "read-token");
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
