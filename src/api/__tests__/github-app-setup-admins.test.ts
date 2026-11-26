import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { registerGitHubIntegrationSetupRoute } = await import("../routes/github/integration.js");
const { resolveGitHubAppRoomIntegrationStatus } = await import("../github/app-installation.js");
const {
  hasPlatformAdmins,
  isPlatformAdminLogin,
  parsePlatformAdminLogins,
} = await import("../github/platform-admins.js");

test("server admins fail closed when LETAGENTS_PLATFORM_ADMINS names nobody", () => {
  for (const raw of [undefined, "", " ", ",", " , @ ,"]) {
    const env = { LETAGENTS_PLATFORM_ADMINS: raw };
    assert.equal(hasPlatformAdmins(env), false, JSON.stringify(raw));
    assert.equal(isPlatformAdminLogin("EmmyMay", env), false, JSON.stringify(raw));
  }
});

test("server admins match named GitHub logins without case or a leading @", () => {
  const env = { LETAGENTS_PLATFORM_ADMINS: " EmmyMay , @Ops-Bot,," };
  assert.deepEqual(parsePlatformAdminLogins(env.LETAGENTS_PLATFORM_ADMINS), ["emmymay", "ops-bot"]);
  assert.equal(hasPlatformAdmins(env), true);
  assert.equal(isPlatformAdminLogin("emmymay", env), true);
  assert.equal(isPlatformAdminLogin("@OPS-BOT", env), true);
  assert.equal(isPlatformAdminLogin("someone-else", env), false);
  assert.equal(isPlatformAdminLogin(null, env), false);
  assert.equal(isPlatformAdminLogin("  ", env), false);
});

test("the setup button shows only to a server admin while no app is configured", () => {
  assert.equal(resolveGitHubAppRoomIntegrationStatus({ configured: false }).setup_manifest_available, false);
  assert.equal(
    resolveGitHubAppRoomIntegrationStatus({ configured: false, isPlatformAdmin: false }).setup_manifest_available,
    false
  );
  assert.equal(
    resolveGitHubAppRoomIntegrationStatus({ configured: false, isPlatformAdmin: true }).setup_manifest_available,
    true
  );
  assert.equal(
    resolveGitHubAppRoomIntegrationStatus({ configured: true, isPlatformAdmin: true }).setup_manifest_available,
    false
  );
});

async function setupServer(login: string) {
  const calls: string[] = [];
  const project = { id: "github.com/attacker/repo" };
  const app = express();
  app.use((req, _res, next) => {
    Object.assign(req, { authKind: "session", sessionAccount: { account_id: "acct_room_admin", login } });
    next();
  });
  registerGitHubIntegrationSetupRoute(app, {
    resolveCanonicalRoomRequestId: async (roomId: string) => roomId,
    resolveRoomRequestOrReply: async (roomId: string) => ({ roomId, project: project as never }),
    resolveRoomOrReply: async () => project as never,
    requireParticipant: async () => true,
    requireAdmin: async () => {
      calls.push("requireAdmin");
      return true;
    },
    getProjectAccessRoomId: () => project.id,
    resolveProjectRepoRoomAccessDecision: async () => ({
      isRepoBacked: true,
      roomName: project.id,
      repoRoomName: project.id,
      binding: null,
      decision: {} as never,
    }),
  });
  // The test database is unreachable. A request that passes both admin checks fails
  // when it saves the setup state; record that instead of logging it.
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    calls.push(/auth_states/.test(error.message) ? "saveSetupState" : `error: ${error.message}`);
    res.status(599).end();
  });
  const http = app.listen(0);
  await new Promise((resolve) => http.once("listening", resolve));
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const post = () =>
    fetch(`${base}/api/rooms/${encodeURIComponent(project.id)}/integrations/github/setup-manifest`, { method: "POST" });
  return { calls, post, close: () => new Promise((resolve) => http.close(resolve)) };
}

async function withPlatformAdmins<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env.LETAGENTS_PLATFORM_ADMINS;
  if (value === undefined) delete process.env.LETAGENTS_PLATFORM_ADMINS;
  else process.env.LETAGENTS_PLATFORM_ADMINS = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.LETAGENTS_PLATFORM_ADMINS;
    else process.env.LETAGENTS_PLATFORM_ADMINS = previous;
  }
}

test("a room admin cannot start GitHub App setup when no server admins are named", async () => {
  await withPlatformAdmins(undefined, async () => {
    const server = await setupServer("attacker");
    try {
      const response = await server.post();
      assert.equal(response.status, 403);
      assert.match((await response.json()).error, /LETAGENTS_PLATFORM_ADMINS/);
      assert.deepEqual(server.calls, ["requireAdmin"], "the room admin check ran, then the server admin check refused");
    } finally {
      await server.close();
    }
  });
});

test("a room admin who is not a named server admin cannot start GitHub App setup", async () => {
  await withPlatformAdmins("EmmyMay", async () => {
    const server = await setupServer("attacker");
    try {
      assert.equal((await server.post()).status, 403);
    } finally {
      await server.close();
    }
  });
});

test("a named server admin passes the admin checks", async () => {
  await withPlatformAdmins("EmmyMay", async () => {
    const server = await setupServer("emmymay");
    try {
      assert.equal((await server.post()).status, 599);
      assert.deepEqual(server.calls, ["requireAdmin", "saveSetupState"]);
    } finally {
      await server.close();
    }
  });
});
