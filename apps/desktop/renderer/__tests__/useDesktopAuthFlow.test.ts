import assert from "node:assert/strict";
import test from "node:test";

import type {
  DesktopAuthStartResult,
  DesktopAuthStatus,
} from "../../electron/ipc-types";
import { useDesktopAuthFlow } from "../src/composables/useDesktopAuthFlow";

test("startAuthFlow surfaces an unscoped device code before explicit browser navigation", async () => {
  const receivedRoomIdentifiers: Array<string | null | undefined> = [];
  const openedUrls: string[] = [];
  const state = useDesktopAuthFlow({
    getRoomIdentifier: () => null,
    isFirstRunGate: () => false,
    onFirstRunAuthorized: async () => undefined,
    onAuthorized: async () => undefined,
    onSignedOut: async () => undefined,
  });

  await withDesktopBridge(
    {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      letagentsDesktop: {
        auth: {
          startDeviceFlow: async (roomIdentifier?: string | null): Promise<DesktopAuthStartResult> => {
            receivedRoomIdentifiers.push(roomIdentifier);
            return {
              pendingDeviceAuth: pendingDeviceAuthFixture(),
              authStatus: authStatusFixture(),
            };
          },
          openVerification: async (url: string): Promise<void> => {
            openedUrls.push(url);
          },
        },
      },
    },
    async () => {
      await state.startAuthFlow();
      assert.equal(state.authStatus.value?.pendingDeviceAuth?.userCode, "ABCD-1234");
      assert.deepEqual(openedUrls, []);
      await state.openVerification("https://github.com/login/device");
      state.clearAuthPollTimer();
    },
  );

  assert.deepEqual(receivedRoomIdentifiers, [null]);
  assert.deepEqual(openedUrls, ["https://github.com/login/device"]);
});

async function withDesktopBridge<T>(
  value: object,
  callback: () => Promise<T>,
): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value,
  });
  try {
    return await callback();
  } finally {
    if (previous) {
      Object.defineProperty(globalThis, "window", previous);
    } else {
      delete (globalThis as { window?: unknown }).window;
    }
  }
}

function pendingDeviceAuthFixture() {
  return {
    requestId: "request_1",
    userCode: "ABCD-1234",
    verificationUri: "https://github.com/login/device",
    expiresAt: "2026-06-30T10:00:00.000Z",
    intervalSeconds: 1,
    roomIdentifier: null,
    startedAt: "2026-06-30T09:55:00.000Z",
  };
}

function authStatusFixture(): DesktopAuthStatus {
  return {
    authenticated: false,
    account: null,
    pendingDeviceAuth: pendingDeviceAuthFixture(),
    apiUrl: "https://letagents.chat",
    tokenStored: false,
    error: null,
  };
}
