import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createElectronTestEnv } from "./harness.js";

// Point the auth store at the harness temp dir BEFORE importing auth.js so the
// module-level cache starts cold against a hermetic file (never the real
// per-user auth store).
const env = createElectronTestEnv({
  prefix: "letagents-auth-transport-",
  paths: [],
  extraCleanupEnvKeys: ["LETAGENTS_DESKTOP_USER_DATA_DIR"],
});
process.env.LETAGENTS_DESKTOP_USER_DATA_DIR = env.tempDir;

const authStorePath = join(env.tempDir, "letagents-desktop-auth.json");

const { apiFetch, clearStoredAuth, pollDeviceAuthFlow } = await import(
  "../main/auth.js"
);

type CapturedRequest = { url: string; init: RequestInit };

/**
 * Replace globalThis.fetch with a recorder that answers with `responseBody` and
 * captures each request's init (so tests can inspect the Authorization header,
 * the signal, and the undici dispatcher).
 */
function installFetchRecorder(
  responseFor: (url: string) => unknown = () => ({ ok: true }),
): { calls: CapturedRequest[]; restore: () => void } {
  const previous = globalThis.fetch;
  const calls: CapturedRequest[] = [];
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, init: init ?? {} });
    return new Response(JSON.stringify(responseFor(url)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = stub;
  return {
    calls,
    restore: () => {
      if (globalThis.fetch === stub) globalThis.fetch = previous;
    },
  };
}

function authHeaderOf(request: CapturedRequest): string | null {
  return new Headers(request.init.headers).get("Authorization");
}

function seedAuthFile(plainToken: string | null): void {
  const persisted: Record<string, unknown> = {
    ownerTokenId: null,
    oauthTokenExpiresAt: null,
    account: null,
    pendingDeviceAuth: null,
    savedAt: new Date().toISOString(),
    encryptedToken: plainToken === null ? null : `plain:${plainToken}`,
  };
  writeFileSync(authStorePath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
}

// This narrative test runs first (module cache is cold at import) and drives the
// full cache lifecycle: warm -> no-reread -> writeStoredAuth refresh -> clear.
test("auth cache: warm read is reused, mutations invalidate/refresh it", async () => {
  const recorder = installFetchRecorder();

  // 1. Seed the store on disk with token-A and warm the cache via apiFetch.
  seedAuthFile("token-A");
  await apiFetch("/warm");
  assert.equal(authHeaderOf(recorder.calls[0]), "Bearer token-A");

  // 2. Overwrite the store on disk with token-B. Only this app writes the
  //    store, so a warm cache must NOT re-read it: the next request still
  //    carries token-A, proving readStoredAuth served the cache.
  seedAuthFile("token-B");
  await apiFetch("/cached");
  assert.equal(
    authHeaderOf(recorder.calls[1]),
    "Bearer token-A",
    "second apiFetch must reuse the cached auth, not re-read the store",
  );

  // 3. Device-auth completion goes through writeStoredAuth, which must refresh
  //    the cache to the freshly-persisted token.
  seedAuthFile(null); // ensure disk cannot be the source of the new token
  recorder.restore();
  const authorizedRecorder = installFetchRecorder(() => ({
    status: "authorized",
    letagents_token: "token-C",
    owner_token_id: "owner-C",
    account: {
      id: "1",
      provider: "github",
      provider_user_id: "gh-1",
      login: "octocat",
    },
  }));
  await pollDeviceAuthFlow("req-1");
  await apiFetch("/after-write");
  const afterWrite = authorizedRecorder.calls.at(-1)!;
  assert.equal(
    authHeaderOf(afterWrite),
    "Bearer token-C",
    "writeStoredAuth must refresh the cache with the new token",
  );

  // 4. Sign-out (clearStoredAuth) must invalidate the cache so no stale token
  //    rides along on subsequent requests.
  await clearStoredAuth();
  await apiFetch("/after-clear");
  const afterClear = authorizedRecorder.calls.at(-1)!;
  assert.equal(
    authHeaderOf(afterClear),
    null,
    "clearStoredAuth must invalidate the cached token",
  );

  authorizedRecorder.restore();
});

test("default timeout: attaches a signal when the caller passes none", async () => {
  const recorder = installFetchRecorder();
  await apiFetch("/no-signal");
  const signal = recorder.calls.at(-1)!.init.signal;
  assert.ok(signal, "apiFetch must attach a default timeout signal");
  assert.equal(typeof signal!.aborted, "boolean");
  recorder.restore();
});

test("default timeout: a caller-provided signal is not overridden", async () => {
  const recorder = installFetchRecorder();
  const controller = new AbortController();
  await apiFetch("/caller-signal", { signal: controller.signal });
  assert.equal(
    recorder.calls.at(-1)!.init.signal,
    controller.signal,
    "the caller's signal must be forwarded unchanged",
  );
  recorder.restore();
});

test("default timeout: timeoutMs=null attaches no signal", async () => {
  const recorder = installFetchRecorder();
  await apiFetch("/opt-out", undefined, { timeoutMs: null });
  assert.equal(
    recorder.calls.at(-1)!.init.signal ?? undefined,
    undefined,
    "timeoutMs:null must disable the default timeout with no replacement",
  );
  recorder.restore();
});

test("default timeout: an elapsed timeout surfaces as a clear Error", async () => {
  const previous = globalThis.fetch;
  // Never resolve until the request's own signal aborts, then reject with the
  // signal reason (mirrors how undici fetch rejects on an aborted signal).
  const stub = (async (_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject((init.signal as AbortSignal).reason);
      });
    })) as typeof fetch;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = stub;

  // AbortSignal.timeout uses an unref'd timer, so hold the event loop open until
  // the assertion settles; otherwise the runner exits before the 5ms fires.
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    await assert.rejects(
      apiFetch("/slow", undefined, { timeoutMs: 5 }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /timed out/i);
        return true;
      },
    );
  } finally {
    clearInterval(keepAlive);
  }

  if (globalThis.fetch === stub) globalThis.fetch = previous;
});

test("dispatcher: apiFetch routes through a shared keep-alive dispatcher", async () => {
  const recorder = installFetchRecorder(() => ({ ok: true, value: 42 }));
  const result = await apiFetch<{ ok: boolean; value: number }>("/smoke");
  assert.deepEqual(result, { ok: true, value: 42 });

  const dispatcher = (recorder.calls.at(-1)!.init as { dispatcher?: unknown })
    .dispatcher as { dispatch?: unknown } | undefined;
  assert.ok(dispatcher, "apiFetch must pass an undici dispatcher");
  assert.equal(
    typeof dispatcher!.dispatch,
    "function",
    "the dispatcher must be an undici Dispatcher (has dispatch())",
  );

  // Two requests should share the same dispatcher instance (one pooled Agent).
  await apiFetch("/smoke-2");
  const first = (recorder.calls[recorder.calls.length - 2].init as {
    dispatcher?: unknown;
  }).dispatcher;
  const second = (recorder.calls.at(-1)!.init as { dispatcher?: unknown })
    .dispatcher;
  assert.equal(first, second, "all apiFetch traffic must share one dispatcher");

  recorder.restore();
});
