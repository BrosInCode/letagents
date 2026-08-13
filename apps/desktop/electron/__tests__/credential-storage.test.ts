import assert from "node:assert/strict";
import test from "node:test";

import {
  MACOS_KEYCHAIN_ACCESS_PATHS,
  openDesktopCredentialStorage,
} from "../main/credential-storage.js";

test("opens the system Keychain Access application", async () => {
  const opened: string[] = [];
  await openDesktopCredentialStorage({
    platform: "darwin",
    shell: {
      openPath: async (path) => {
        opened.push(path);
        return "";
      },
    },
  });
  assert.deepEqual(opened, [MACOS_KEYCHAIN_ACCESS_PATHS[0]]);
});

test("falls back to the legacy Keychain Access location", async () => {
  const opened: string[] = [];
  await openDesktopCredentialStorage({
    platform: "darwin",
    shell: {
      openPath: async (path) => {
        opened.push(path);
        return opened.length === 1 ? "not found" : "";
      },
    },
  });
  assert.deepEqual(opened, [...MACOS_KEYCHAIN_ACCESS_PATHS]);
});

test("does not offer macOS Keychain recovery on another platform", async () => {
  await assert.rejects(
    openDesktopCredentialStorage({ platform: "linux", shell: { openPath: async () => "" } }),
    /only available on macOS/,
  );
});
