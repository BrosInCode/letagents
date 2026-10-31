import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { createElectronTestEnv, testEncryptedToken } from './harness.js';

const env = createElectronTestEnv({ prefix: 'letagents-auth-decrypt-failure-', paths: [], extraCleanupEnvKeys: ['LETAGENTS_DESKTOP_USER_DATA_DIR'] });
process.env.LETAGENTS_DESKTOP_USER_DATA_DIR = env.tempDir;
const require = createRequire(import.meta.url);
const id = require.resolve('electron'); const previous = require.cache[id];
let failToken: string | null = null; let reads = 0;
require.cache[id] = { id, filename: id, loaded: true, exports: { safeStorage: {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(value),
  decryptString: (value: Buffer) => { reads++; const token = value.toString(); if (token === failToken) throw new Error('private native error'); return token; },
} } } as NodeJS.Module;
test.after(() => { if (previous) require.cache[id] = previous; else delete require.cache[id]; });
const { resetStoredAuthCacheForTest, getDesktopAuthStatus, pollDeviceAuthFlow, readStoredAuth, setStoredAuthDecryptFailureTtlMsForTest, startDeviceAuthFlow } = await import('../main/auth.js');

test('with a permanently undecryptable auth file, sign-in start and completion still write a fresh file', async () => {
  const path = join(env.tempDir, 'letagents-desktop-auth.json');
  const stored = JSON.stringify({ version: 2, encryptedToken: testEncryptedToken('app-test'), encryptedAgentToken: testEncryptedToken('agent-test'), encryptedAppLoginVerifier: testEncryptedToken('verifier-test'), account: { id: 'account-test' }, savedAt: new Date().toISOString() });
  writeFileSync(path, stored);
  resetStoredAuthCacheForTest();
  failToken = 'app-test';
  setStoredAuthDecryptFailureTtlMsForTest(60_000);
  assert.equal((await readStoredAuth()).token, null, 'plain readers see signed out and start the negative window');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes('/auth/app/start')) return Response.json({
      request_id: 'recover-1', user_code: 'ABCD-1234', verification_uri: 'https://letagents.chat/auth/app/authorize/test', expires_in: 600, interval: 5,
    });
    return Response.json({
      status: 'authorized', app_session: 'fresh-app-token', agent_token: 'fresh-agent-token',
      account: { id: 'test', provider: 'github', provider_user_id: 'test', login: 'test' },
    });
  }) as typeof fetch;
  try {
    const started = await startDeviceAuthFlow();
    assert.equal(started.pendingDeviceAuth?.requestId, 'recover-1', 'start works from an unreadable file');
    assert.notEqual(readFileSync(path, 'utf8'), stored, 'the unreadable file was replaced');
    assert.equal((await pollDeviceAuthFlow()).status, 'authorized', 'completion writes the new credentials');
    assert.equal((await readStoredAuth()).token, 'fresh-app-token');
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).version, 2);
  } finally {
    globalThis.fetch = originalFetch;
    failToken = null;
    setStoredAuthDecryptFailureTtlMsForTest(0);
  }
});

test('an account refresh keeps unreadable ciphertext instead of overwriting it', async () => {
  const path = join(env.tempDir, 'letagents-desktop-auth.json');
  const stored = JSON.stringify({ version: 2, encryptedToken: testEncryptedToken('app-test'), encryptedAgentToken: testEncryptedToken('agent-test'), encryptedAppLoginVerifier: testEncryptedToken('verifier-test'), account: { id: 'account-test' }, savedAt: new Date().toISOString() });
  writeFileSync(path, stored);
  resetStoredAuthCacheForTest();
  failToken = 'app-test';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('an unreadable session must not be validated'); }) as typeof fetch;
  try {
    await getDesktopAuthStatus();
    assert.equal(readFileSync(path, 'utf8'), stored);
  } finally { globalThis.fetch = originalFetch; failToken = null; }
});

test('a failed decrypt is remembered briefly so concurrent requests do not each retry it, and recovery is seen after the window', async () => {
  const path = join(env.tempDir, 'letagents-desktop-auth.json');
  writeFileSync(path, JSON.stringify({ version: 2, encryptedToken: testEncryptedToken('app-test'), encryptedAgentToken: testEncryptedToken('agent-test'), encryptedAppLoginVerifier: testEncryptedToken('verifier-test'), account: { id: 'account-test' }, savedAt: new Date().toISOString() }));
  resetStoredAuthCacheForTest();
  failToken = 'app-test';
  setStoredAuthDecryptFailureTtlMsForTest(0);
  reads = 0;
  await Promise.all(Array.from({ length: 10 }, () => readStoredAuth()));
  const withoutNegativeCache = reads;
  setStoredAuthDecryptFailureTtlMsForTest(150);
  reads = 0;
  for (let index = 0; index < 10; index += 1) assert.equal((await readStoredAuth()).token, null);
  const withNegativeCache = reads;
  console.log(`item7 decrypts for 10 reads while the Keychain fails: before=${withoutNegativeCache} after=${withNegativeCache}`);
  assert.equal(withNegativeCache, 3, 'one attempt decrypts the three stored tokens; the other nine reads do not');
  assert.ok(withoutNegativeCache > withNegativeCache);
  failToken = null;
  assert.equal((await readStoredAuth()).token, null, 'inside the window the answer stays signed out');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal((await readStoredAuth()).token, 'app-test', 'after the window the decrypt is tried again and succeeds');
  assert.equal(await readStoredAuth() === await readStoredAuth(), true, 'a success is cached as before');
});
