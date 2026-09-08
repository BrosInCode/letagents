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

test("first-run authorization enters room setup without leaking a success banner", async () => {
  let firstRunAuthorizedCount = 0;
  const state = useDesktopAuthFlow({
    getRoomIdentifier: () => null,
    isFirstRunGate: () => true,
    onFirstRunAuthorized: async () => {
      firstRunAuthorizedCount += 1;
    },
    onAuthorized: async () => undefined,
    onSignedOut: async () => undefined,
  });

  await withDesktopBridge(
    {
      letagentsDesktop: {
        auth: {
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
    () => state.pollAuthFlow(),
  );

  assert.equal(firstRunAuthorizedCount, 1);
  assert.equal(state.authFeedback.value, null);
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

test("cancelAuthFlow stops polling and clears the pending device request", async () => {
  const clearedTimers: number[] = [];
  const authStatus = ref<DesktopAuthStatus | null>(authStatusFixture());
  const state = useDesktopAuthFlow({
    authStatus,
    getRoomIdentifier: () => null,
    isFirstRunGate: () => true,
    onFirstRunAuthorized: async () => undefined,
    onAuthorized: async () => undefined,
    onSignedOut: async () => undefined,
  });

  await withDesktopBridge(
    {
      setTimeout: () => 41,
      clearTimeout: (timer: number) => clearedTimers.push(timer),
      letagentsDesktop: {
        auth: {
          cancelDeviceFlow: async (): Promise<DesktopAuthStatus> => ({
            ...authStatusFixture(),
            pendingDeviceAuth: null,
          }),
        },
      },
    },
    async () => {
      state.scheduleAuthPoll();
      await state.cancelAuthFlow();
    },
  );

  assert.deepEqual(clearedTimers, [41]);
  assert.equal(state.authStatus.value?.pendingDeviceAuth, null);
  assert.equal(state.authBusy.value, false);
  assert.equal(state.authFeedback.value, null);
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
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    intervalSeconds: 1,
    roomIdentifier: null,
    startedAt: new Date().toISOString(),
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


test("automatic sign-in recovers from transient API and IPC failures", async () => {
  for (const failure of ["unknown", "throw"] as const) {
    const authStatus = ref<DesktopAuthStatus | null>(authStatusFixture());
    const scheduled = new Map<number, () => void>();
    let nextTimer = 0;
    let polls = 0;
    let authorized = 0;
    const state = useDesktopAuthFlow({
      authStatus,
      getRoomIdentifier: () => null,
      isFirstRunGate: () => false,
      onFirstRunAuthorized: async () => undefined,
      onAuthorized: async () => { authorized += 1; },
      onSignedOut: async () => undefined,
    });
    await withDesktopBridge({
      setTimeout: (callback: () => void, delay: number) => {
        assert.ok(delay >= 2000);
        scheduled.set(++nextTimer, callback);
        return nextTimer;
      },
      clearTimeout: (id: number) => scheduled.delete(id),
      letagentsDesktop: { auth: { pollDeviceFlow: async () => {
        polls += 1;
        if (polls === 1 && failure === "throw") throw new Error("Network unavailable");
        return {
          status: polls === 1 ? "unknown" : "authorized",
          intervalSeconds: 1,
          expiresInSeconds: null,
          authStatus: polls === 1 ? authStatusFixture() : authenticatedStatusFixture(),
          error: polls === 1 ? "Network unavailable" : null,
        };
      } } },
    }, async () => {
      await state.pollAuthFlow({ automatic: true });
      assert.equal(scheduled.size, 1, failure);
      const retry = scheduled.values().next().value!;
      scheduled.clear();
      retry();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(polls, 2, failure);
      assert.equal(authorized, 1, failure);
      assert.equal(scheduled.size, 0, failure);
    });
  }
});

test("terminal sign-in results never retain an automatic retry", async () => {
  for (const status of ["denied", "expired", "unknown"] as const) {
    const scheduled = new Map<number, () => void>();
    let nextTimer = 0;
    const state = useDesktopAuthFlow({
      authStatus: ref<DesktopAuthStatus | null>(authStatusFixture()),
      getRoomIdentifier: () => null,
      isFirstRunGate: () => false,
      onFirstRunAuthorized: async () => undefined,
      onAuthorized: async () => undefined,
      onSignedOut: async () => undefined,
    });
    await withDesktopBridge({
      setTimeout: (callback: () => void) => {
        scheduled.set(++nextTimer, callback);
        return nextTimer;
      },
      clearTimeout: (id: number) => scheduled.delete(id),
      letagentsDesktop: { auth: { pollDeviceFlow: async () => ({
        status,
        intervalSeconds: null,
        expiresInSeconds: null,
        authStatus: { ...authStatusFixture(), pendingDeviceAuth: null },
        error: "Start again",
      }) } },
    }, async () => {
      state.scheduleAuthPoll();
      await state.pollAuthFlow();
      assert.equal(scheduled.size, 0, status);
    });
  }
});

test("retry timers stop at device-code expiry, including after suspend", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const authStatus = ref<DesktopAuthStatus | null>(authStatusFixture());
  authStatus.value!.pendingDeviceAuth!.expiresAt = new Date(Date.now() + 1000).toISOString();
  let callback: (() => void) | undefined;
  let polls = 0;
  const state = useDesktopAuthFlow({
    authStatus,
    getRoomIdentifier: () => null,
    isFirstRunGate: () => false,
    onFirstRunAuthorized: async () => undefined,
    onAuthorized: async () => undefined,
    onSignedOut: async () => undefined,
  });
  await withDesktopBridge({
    setTimeout: (fn: () => void, delay: number) => {
      assert.equal(delay, 1000);
      callback = fn;
      return 1;
    },
    clearTimeout: () => undefined,
    letagentsDesktop: { auth: { pollDeviceFlow: async () => { polls += 1; } } },
  }, async () => {
    state.scheduleAuthPoll();
    assert.ok(callback);
    t.mock.timers.tick(2000);
    callback!();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(polls, 0);
    assert.match(state.authFeedback.value!, /expired/i);
    callback = undefined;
    state.scheduleAuthPoll();
    assert.equal(callback, undefined);
  });
});
