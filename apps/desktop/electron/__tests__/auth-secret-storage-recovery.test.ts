import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { createElectronTestEnv, testEncryptedToken } from './harness.js';

const env = createElectronTestEnv({ prefix: 'letagents-auth-storage-recovery-', paths: [], extraCleanupEnvKeys: ['LETAGENTS_DESKTOP_USER_DATA_DIR'] });
process.env.LETAGENTS_DESKTOP_USER_DATA_DIR = env.tempDir;
const require = createRequire(import.meta.url);
const id = require.resolve('electron'); const previous = require.cache[id];
let available = false; let failToken: string | null = null; let reads = 0;
require.cache[id] = { id, filename: id, loaded: true, exports: { safeStorage: {
  isEncryptionAvailable: () => available,
  encryptString: (value: string) => Buffer.from(value),
  decryptString: (value: Buffer) => { reads++; const token = value.toString(); if (token === failToken) throw new Error('private native error'); return token; },
} } } as NodeJS.Module;
test.after(() => { if (previous) require.cache[id] = previous; else delete require.cache[id]; });
const { getDesktopAuthStatus, readStoredAuth, setStoredAuthDecryptFailureTtlMsForTest } = await import('../main/auth.js');

test('locked, failed, or partial credential reads stay uncached and never overwrite stored credentials', async () => {
  setStoredAuthDecryptFailureTtlMsForTest(0); // this test checks that every read retries the decrypt
  const path = join(env.tempDir, 'letagents-desktop-auth.json');
  const stored = JSON.stringify({ version: 2, encryptedToken: testEncryptedToken('app-test'), encryptedAgentToken: testEncryptedToken('agent-test'), encryptedAppLoginVerifier: testEncryptedToken('verifier-test'), account: { id: 'account-test' }, savedAt: new Date().toISOString() });
  writeFileSync(path, stored);
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('A partial session must not be validated or written'); }) as typeof fetch;
  try {
    for (const failure of ['locked', 'agent-test', 'verifier-test', 'app-test']) {
      available = failure !== 'locked'; failToken = failure;
      const result = await getDesktopAuthStatus();
      assert.equal(result.authenticated, false);
      assert.equal(result.tokenStored, false);
      assert.equal(result.account, null);
      assert.equal(readFileSync(path, 'utf8'), stored, 'preserve all ciphertext while storage is unavailable');
    }
    failToken = null;
    const recovered = await readStoredAuth();
    assert.equal(recovered.token, 'app-test');
    assert.equal(recovered.agentToken, 'agent-test');
    assert.equal(recovered.appLoginVerifier, 'verifier-test');
    const successfulReads = reads; available = false;
    assert.equal(await readStoredAuth(), recovered, 'successful reads still use the cache');
    assert.equal(reads, successfulReads);
  } finally { globalThis.fetch = fetchBefore; }
});
