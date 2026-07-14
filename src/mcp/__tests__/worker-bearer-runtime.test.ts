import assert from "node:assert/strict";
import test from "node:test";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

const {
  getWorkerBearerRuntime,
  requireValidWorkerBearerRuntime,
  WorkerBearerRuntimeConfigurationError,
} = await import("../server/runtime/worker-bearer.js");
const { apiCall } = await import("../server/runtime/api.js");

function withAuthEnv<T>(
  values: { bearer?: string | undefined; owner?: string | undefined },
  callback: () => T | Promise<T>,
): Promise<T> | T {
  const previousBearer = process.env.LETAGENTS_AGENT_SESSION_BEARER;
  const previousOwner = process.env.LETAGENTS_TOKEN;
  if (values.bearer === undefined) delete process.env.LETAGENTS_AGENT_SESSION_BEARER;
  else process.env.LETAGENTS_AGENT_SESSION_BEARER = values.bearer;
  if (values.owner === undefined) delete process.env.LETAGENTS_TOKEN;
  else process.env.LETAGENTS_TOKEN = values.owner;
  return Promise.resolve(callback()).finally(() => {
    if (previousBearer === undefined) delete process.env.LETAGENTS_AGENT_SESSION_BEARER;
    else process.env.LETAGENTS_AGENT_SESSION_BEARER = previousBearer;
    if (previousOwner === undefined) delete process.env.LETAGENTS_TOKEN;
    else process.env.LETAGENTS_TOKEN = previousOwner;
  });
}

test("worker bearer mode uses the worker Authorization header without owner credentials", async () => {
  const originalFetch = globalThis.fetch;
  await withAuthEnv({ bearer: "worker-secret", owner: undefined }, async () => {
    globalThis.fetch = async (_url, init) => {
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer worker-secret");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    assert.deepEqual(await apiCall("/rooms/room_1/messages"), { ok: true });
  });
  globalThis.fetch = originalFetch;
});

test("worker bearer mode rejects dual owner credentials before an API request", async () => {
  const originalFetch = globalThis.fetch;
  await withAuthEnv({ bearer: "worker-secret", owner: "owner-secret" }, async () => {
    globalThis.fetch = async () => assert.fail("dual credentials must fail before fetch");
    assert.deepEqual(getWorkerBearerRuntime(), {
      mode: "invalid",
      error: "Worker bearer mode refuses LETAGENTS_TOKEN. Remove the owner token from this process before starting the worker.",
    });
    assert.throws(() => requireValidWorkerBearerRuntime(), WorkerBearerRuntimeConfigurationError);
    await assert.rejects(() => apiCall("/rooms/room_1/messages"), WorkerBearerRuntimeConfigurationError);
  });
  globalThis.fetch = originalFetch;
});

test("blank worker bearer does not activate worker mode", async () => {
  await withAuthEnv({ bearer: "  ", owner: undefined }, async () => {
    assert.deepEqual(getWorkerBearerRuntime(), { mode: "owner" });
  });
});
