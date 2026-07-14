import assert from "node:assert/strict";
import test from "node:test";

import { Buffer } from "node:buffer";
import { decryptSupervisorGrantFromStorage, encryptSupervisorGrantForStorage } from "../main/supervisor-grant.js";

test("supervisor grant storage uses the injected Keychain adapter and never returns plaintext", () => {
  const storage = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`keychain:${value}`),
    decryptString: (value: Buffer) => value.toString("utf8").replace("keychain:", ""),
  };
  const stored = encryptSupervisorGrantForStorage("lashg_secret", storage);
  assert.match(stored, /^safe:/);
  assert.doesNotMatch(stored, /lashg_secret/);
  assert.equal(decryptSupervisorGrantFromStorage(stored, storage), "lashg_secret");
});

test("supervisor grant storage fails closed without Keychain encryption", () => {
  const unavailable = {
    isEncryptionAvailable: () => false,
    encryptString: (_value: string) => Buffer.alloc(0),
    decryptString: (_value: Buffer) => "",
  };
  assert.throws(() => encryptSupervisorGrantForStorage("lashg_secret", unavailable), /Keychain encryption is unavailable/);
  assert.equal(decryptSupervisorGrantFromStorage("plain:lashg_secret", unavailable), null);
});
