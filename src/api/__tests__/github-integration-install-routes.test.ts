import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
process.env.DB_URL ??= 'postgresql://test:test@127.0.0.1:1/test';
const { registerGitHubIntegrationRoutes } = await import('../routes/github/integration.js');

const project = { id: 'github.com/bobaifromtima/tima-connect' };

async function server(auth: string | null, role: 'admin' | 'participant') {
  const calls: string[] = [];
  const app = express();
  app.use((req, _res, next) => {
    Object.assign(req, { authKind: auth, sessionAccount: auth && auth !== 'agent_session' ? { account_id: 'acct-kd', login: 'kdnotfound', provider: 'github' } : null });
    next();
  });
  registerGitHubIntegrationRoutes(app, {
    resolveCanonicalRoomRequestId: async (roomId: string) => roomId,
    resolveRoomOrReply: (async () => project) as never,
    requireParticipant: async () => true,
    requireAdmin: (async (_req: unknown, res: express.Response) => {
      calls.push('requireAdmin');
      res.status(403).json({ error: 'Worker bearers cannot perform owner or admin actions.' });
      return false;
    }) as never,
    resolveProjectRole: (async () => { calls.push('resolveProjectRole'); return role; }) as never,
    getProjectAccessRoomId: () => project.id,
    resolveProjectRepoRoomAccessDecision: (async () => ({
      isRepoBacked: true, roomName: project.id, repoRoomName: project.id, binding: null, decision: { kind: 'allow' },
    })) as never,
  });
  const http = app.listen(0);
  await new Promise(resolve => http.once('listening', resolve));
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  return { base, calls, close: () => new Promise(resolve => http.close(resolve)) };
}

const installPath = `/api/rooms/${encodeURIComponent(project.id)}/integrations/github/install-url`;

test('a write collaborator is told that the repository owner or an admin must install the GitHub app', async () => {
  const s = await server('session', 'participant');
  try {
    const response = await fetch(`${s.base}${installPath}`, { method: 'POST' });
    assert.equal(response.status, 403);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.error, 'Admin privileges required');
    assert.equal(body.code, 'GITHUB_APP_INSTALL_ADMIN_REQUIRED');
    assert.equal(body.repository, 'bobaifromtima/tima-connect');
    assert.match(String(body.message), /^Only the owner or an admin of bobaifromtima\/tima-connect on GitHub can install the GitHub app for this room\. Write access is not enough\./);
    assert.deepEqual(s.calls, ['resolveProjectRole']);
  } finally { await s.close(); }
});

test('worker bearers keep the existing admin refusal', async () => {
  const s = await server('agent_session', 'admin');
  try {
    const response = await fetch(`${s.base}${installPath}`, { method: 'POST' });
    assert.equal(response.status, 403);
    assert.deepEqual(s.calls, ['requireAdmin']);
  } finally { await s.close(); }
});
