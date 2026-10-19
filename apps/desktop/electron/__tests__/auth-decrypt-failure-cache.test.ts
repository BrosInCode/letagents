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
const { cancelDeviceAuthFlow, readStoredAuth, setStoredAuthDecryptFailureTtlMsForTest } = await import('../main/auth.js');

test('a read-modify-write bypasses the negative cache and fails instead of overwriting unreadable ciphertext', async () => {
  const path = join(env.tempDir, 'letagents-desktop-auth.json');
  const stored = JSON.stringify({ version: 2, encryptedToken: testEncryptedToken('app-test'), encryptedAgentToken: testEncryptedToken('agent-test'), encryptedAppLoginVerifier: testEncryptedToken('verifier-test'), account: { id: 'account-test' }, savedAt: new Date().toISOString() });
  writeFileSync(path, stored);
  failToken = 'app-test';
  setStoredAuthDecryptFailureTtlMsForTest(60_000);
  assert.equal((await readStoredAuth()).token, null, 'plain readers see signed out and start the negative window');
  await assert.rejects(cancelDeviceAuthFlow(), /temporarily unavailable/, 'an update inside the window does not read an empty copy');
  assert.equal(readFileSync(path, 'utf8'), stored, 'the ciphertext is untouched');
  failToken = null;
  setStoredAuthDecryptFailureTtlMsForTest(0);
});

test('a failed decrypt is remembered briefly so concurrent requests do not each retry it, and recovery is seen after the window', async () => {
  const path = join(env.tempDir, 'letagents-desktop-auth.json');
  writeFileSync(path, JSON.stringify({ version: 2, encryptedToken: testEncryptedToken('app-test'), encryptedAgentToken: testEncryptedToken('agent-test'), encryptedAppLoginVerifier: testEncryptedToken('verifier-test'), account: { id: 'account-test' }, savedAt: new Date().toISOString() }));
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
