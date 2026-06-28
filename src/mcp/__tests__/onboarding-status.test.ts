import assert from "node:assert/strict";
import test from "node:test";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

const { checkOnboardingApiHealth } = await import("../server/tools/onboarding/status-tool.js");

test("checkOnboardingApiHealth reports reachable API health", async () => {
  const calls: Array<{ url: string; aborted: boolean }> = [];
  const health = await checkOnboardingApiHealth(
    "https://letagents.chat/",
    async (url, init) => {
      calls.push({ url, aborted: init.signal.aborted });
      return { ok: true, status: 200 };
    },
    50
  );

  assert.deepEqual(calls, [
    { url: "https://letagents.chat/api/health", aborted: false },
  ]);
  assert.deepEqual(health, {
    url: "https://letagents.chat/api/health",
    reachable: true,
    status: 200,
    error: null,
  });
});

test("checkOnboardingApiHealth reports fetch failures without throwing", async () => {
  const health = await checkOnboardingApiHealth(
    "http://localhost:3001",
    async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:3001");
    },
    50
  );

  assert.deepEqual(health, {
    url: "http://localhost:3001/api/health",
    reachable: false,
    status: null,
    error: "connect ECONNREFUSED 127.0.0.1:3001",
  });
});
