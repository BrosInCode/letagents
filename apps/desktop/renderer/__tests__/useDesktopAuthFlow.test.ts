import assert from "node:assert/strict";
import test from "node:test";
import { ref } from "vue";

import type {
  DesktopAuthStartResult,
  DesktopAuthStatus,
} from "../../electron/ipc-types";
import { useDesktopAuthFlow } from "../src/composables/useDesktopAuthFlow";

test("startAuthFlow surfaces an unscoped device code before explicit browser navigation", async () => {
  const receivedRoomIdentifiers: Array<string | null | undefined> = [];
  const openedUrls: string[] = [];
  const state = useDesktopAuthFlow({
    getRoomIdentifier: () => "github.com/BrosInCode/private-room",
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
      await state.startAuthFlow(null);
      assert.equal(state.authSessionLocked.value, true);
      assert.equal(state.authStatus.value?.pendingDeviceAuth?.userCode, "ABCD-1234");
      assert.deepEqual(openedUrls, []);
      await state.openVerification("https://github.com/login/device");
      state.clearAuthPollTimer();
    },
  );

  assert.deepEqual(receivedRoomIdentifiers, [null]);
  assert.deepEqual(openedUrls, ["https://github.com/login/device"]);
});

test("signOut locks the shell and clears renderer auth before IPC completes", async () => {
  let finishSignOut: ((status: DesktopAuthStatus) => void) | null = null;
  let signingOutCount = 0;
  let signedOutCount = 0;
  const signOutPending = new Promise<DesktopAuthStatus>((resolve) => {
    finishSignOut = resolve;
  });
  const authStatus = ref<DesktopAuthStatus | null>({
    authenticated: true,
    account: {
      id: "account_1",
      provider: "github",
      providerUserId: "user_1",
      login: "emmy",
      displayName: "Emmy",
      avatarUrl: null,
    },
    pendingDeviceAuth: null,
    apiUrl: "https://letagents.chat",
    tokenStored: true,
    error: null,
  });
  const state = useDesktopAuthFlow({
    authStatus,
    getRoomIdentifier: () => null,
    isFirstRunGate: () => false,
    onFirstRunAuthorized: async () => undefined,
    onAuthorized: async () => undefined,
    onSigningOut: () => {
      signingOutCount += 1;
    },
    onSignedOut: async () => {
      signedOutCount += 1;
    },
  });

  await withDesktopBridge(
    {
      letagentsDesktop: {
        auth: {
          signOut: () => signOutPending,
        },
      },
    },
    async () => {
      const operation = state.signOut();
      assert.equal(state.authSessionLocked.value, true);
      assert.equal(state.authStatus.value?.authenticated, false);
      assert.equal(state.authStatus.value?.account, null);
      assert.equal(state.authStatus.value?.tokenStored, false);
      assert.equal(signingOutCount, 1);
      assert.equal(signedOutCount, 0);

      finishSignOut?.(authStatusFixture());
      await operation;
    },
  );

  assert.equal(state.authSessionLocked.value, true);
  assert.equal(state.authStatus.value?.authenticated, false);
  assert.equal(signedOutCount, 1);
});

test("authorized polling keeps the shell locked when the authoritative refresh fails", async () => {
  const authStatus = ref<DesktopAuthStatus | null>(authStatusFixture());
  const state = useDesktopAuthFlow({
    authStatus,
    getRoomIdentifier: () => null,
    isFirstRunGate: () => false,
    onFirstRunAuthorized: async () => undefined,
    onAuthorized: async () => {
      throw new Error("Authoritative refresh failed");
    },
    onSignedOut: async () => undefined,
  });

  await withDesktopBridge(
    {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      letagentsDesktop: {
        auth: {
          startDeviceFlow: async (): Promise<DesktopAuthStartResult> => ({
            pendingDeviceAuth: pendingDeviceAuthFixture(),
            authStatus: authStatusFixture(),
          }),
          pollDeviceFlow: async () => ({
            status: "authorized" as const,
            intervalSeconds: null,
            expiresInSeconds: null,
            authStatus: authenticatedStatusFixture(),
            error: null,
          }),
        },
      },
    },
    async () => {
      await state.startAuthFlow(null);
      await state.pollAuthFlow();
      state.clearAuthPollTimer();
    },
  );

  assert.equal(state.authStatus.value?.authenticated, true);
  assert.equal(state.authSessionLocked.value, true);
  assert.equal(state.authFeedback.value, "Authoritative refresh failed");
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

function authenticatedStatusFixture(): DesktopAuthStatus {
  return {
    authenticated: true,
    account: {
      id: "account_1",
      provider: "github",
      providerUserId: "user_1",
      login: "emmy",
      displayName: "Emmy",
      avatarUrl: null,
    },
    pendingDeviceAuth: null,
    apiUrl: "https://letagents.chat",
    tokenStored: true,
    error: null,
  };
}
