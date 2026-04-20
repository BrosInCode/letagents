import assert from "node:assert/strict";
import test from "node:test";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { registerGitHubWebhookRoutes } = await import("../routes/github-webhooks.js");

function createDeps() {
  return {
    toGitHubWebhookId: () => null,
    handleGitHubWebhookEvent: async () => ({
      status: "ignored" as const,
      installationId: null,
      githubRepoId: null,
      roomId: null,
    }),
  };
}

test("registerGitHubWebhookRoutes preserves webhook route order", () => {
  const calls: Array<{ method: "post"; path: string }> = [];
  const app = {
    post(path: string) {
      calls.push({ method: "post", path });
    },
  };

  registerGitHubWebhookRoutes(app as never, createDeps() as never);

  assert.deepEqual(calls, [
    { method: "post", path: "/webhooks/github" },
  ]);
});
