import { getCurrentScope, onScopeDispose, ref, type Ref } from "vue";
import type { DesktopAuthStatus } from "../../../electron/ipc-types";
import { desktopIpc } from "../ipc/index.js";

interface DesktopAuthFlowOptions {
  authStatus?: Ref<DesktopAuthStatus | null>;
  getRoomIdentifier: () => string | null;
  isFirstRunGate: () => boolean;
  onFirstRunAuthorized: () => Promise<void>;
  onAuthorized: () => Promise<void>;
  onSigningOut?: () => void;
  onSignedOut: () => Promise<void>;
}

export function useDesktopAuthFlow(options: DesktopAuthFlowOptions) {
  const authStatus = options.authStatus ?? ref<DesktopAuthStatus | null>(null);
  const authBusy = ref(false);
  const authFeedback = ref<string | null>(null);
  // This lock is independent of status refreshes. Once the user signs out, an
  // older in-flight refresh must never be able to remount the room shell with a
  // stale authenticated snapshot.
  const authSessionLocked = ref(false);
  let authPollTimer: number | null = null;
  let authGeneration = 0;
  let pollingGeneration: number | null = null;
  let retryCount = 0;

  function clearAuthPollTimer(): void {
    if (authPollTimer === null) return;
    window.clearTimeout(authPollTimer);
    authPollTimer = null;
  }

  function scheduleAuthPoll(): void {
    clearAuthPollTimer();
    const pending = authStatus.value?.pendingDeviceAuth;
    if (!pending) return;

    const generation = authGeneration;
    const remainingMs = Date.parse(pending.expiresAt) - Date.now();
    // The main process expires the request locally, including its stored verifier.
    // One final IPC at the deadline clears the code and reveals the restart action.
    const intervalMs = Math.max(2, pending.intervalSeconds) * 1000 + 350;
    const backoffMs = retryCount === 0 ? 0 : Math.min(30_000, 2_000 * 2 ** retryCount);
    const waitMs = Math.max(0, Math.min(Math.max(intervalMs, backoffMs), remainingMs));
    authPollTimer = window.setTimeout(() => {
      if (generation !== authGeneration) return;
      authPollTimer = null;
      void pollAuthFlow({ automatic: true });
    }, waitMs);
  }

  async function startAuthFlow(roomIdentifierOverride?: string | null): Promise<void> {
    const generation = ++authGeneration;
    retryCount = 0;
    clearAuthPollTimer();
    if (!authStatus.value?.authenticated) authSessionLocked.value = true;
    authBusy.value = true;
    authFeedback.value = null;
    try {
      const roomIdentifier = roomIdentifierOverride === undefined
        ? options.getRoomIdentifier()
        : roomIdentifierOverride;
      const result = await desktopIpc.auth.startDeviceFlow(roomIdentifier);
      if (generation !== authGeneration) return;
      authStatus.value = result.authStatus;
      scheduleAuthPoll();
    } catch (error) {
      if (generation !== authGeneration) return;
      authFeedback.value = error instanceof Error ? error.message : "Could not start sign-in.";
    } finally {
      if (generation === authGeneration) authBusy.value = false;
    }
  }

  async function openVerification(url: string): Promise<void> {
    const generation = authGeneration;
    authBusy.value = true;
    authFeedback.value = null;
    try {
      await desktopIpc.auth.openVerification(url);
    } catch (error) {
      if (generation !== authGeneration) return;
      authFeedback.value = error instanceof Error ? error.message : "Could not open your browser.";
    } finally {
      if (generation === authGeneration) authBusy.value = false;
    }
  }

  async function cancelAuthFlow(): Promise<void> {
    const generation = ++authGeneration;
    retryCount = 0;
    clearAuthPollTimer();
    authBusy.value = true;
    authFeedback.value = null;
    const previousStatus = authStatus.value;
    authStatus.value = signedOutStatus(previousStatus);
    try {
      const status = await desktopIpc.auth.cancelDeviceFlow();
      if (generation !== authGeneration) return;
      authStatus.value = status;
    } catch (error) {
      if (generation !== authGeneration) return;
      authStatus.value = previousStatus;
      authFeedback.value = error instanceof Error ? error.message : "Could not cancel GitHub sign-in.";
      scheduleAuthPoll();
    } finally {
      if (generation === authGeneration) authBusy.value = false;
    }
  }

  async function pollAuthFlow(optionsOverride: { automatic?: boolean } = {}): Promise<void> {
    const generation = authGeneration;
    if (pollingGeneration === generation) return;
    pollingGeneration = generation;
    clearAuthPollTimer();
    if (!optionsOverride.automatic) {
      authBusy.value = true;
    }
    const pending = authStatus.value?.pendingDeviceAuth;
    const expired = pending && !(Date.parse(pending.expiresAt) > Date.now());
    if (expired && authStatus.value) {
      authStatus.value = { ...authStatus.value, pendingDeviceAuth: null };
      authFeedback.value = "This sign-in request expired. Request a new code to continue.";
    }
    try {
      const result = await desktopIpc.auth.pollDeviceFlow();
      if (generation !== authGeneration) return;
      authStatus.value = result.authStatus;

      if (result.status === "authorized") {
        retryCount = 0;
        authFeedback.value = null;
        if (options.isFirstRunGate()) {
          await options.onFirstRunAuthorized();
          if (generation !== authGeneration) return;
          authSessionLocked.value = false;
          authFeedback.value = null;
          return;
        }
        await options.onAuthorized();
        if (generation !== authGeneration) return;
        authSessionLocked.value = false;
        return;
      }

      if (result.status === "pending" || result.status === "slow_down") {
        retryCount = result.status === "slow_down" ? Math.min(retryCount + 1, 4) : 0;
        // The view already explains approval. Background transport activity must
        // not repeatedly remove/reinsert feedback or toggle foreground loading.
        authFeedback.value = null;
        scheduleAuthPoll();
        return;
      }

      if (result.status === "unknown" && authStatus.value?.pendingDeviceAuth) {
        retryApproval();
        return;
      }
      authFeedback.value = result.status === "expired"
        ? "This sign-in request expired. Request a new code to continue."
        : result.status === "denied"
          ? "This sign-in request was declined. Start again when you are ready."
          : result.error || "Sign-in did not complete. Start again when you are ready.";
    } catch (error) {
      if (generation !== authGeneration) return;
      if (authStatus.value?.pendingDeviceAuth) {
        retryApproval();
      } else if (!expired) {
        authFeedback.value = error instanceof Error ? error.message : "Could not finish sign-in.";
      }
    } finally {
      if (pollingGeneration === generation) pollingGeneration = null;
      if (!optionsOverride.automatic) {
        if (generation === authGeneration) authBusy.value = false;
      }
    }
  }

  function retryApproval(): void {
    retryCount = Math.min(retryCount + 1, 4);
    authFeedback.value = "Connection interrupted. Retrying automatically.";
    scheduleAuthPoll();
  }

  async function signOut(): Promise<void> {
    const generation = ++authGeneration;
    retryCount = 0;
    clearAuthPollTimer();
    authSessionLocked.value = true;
    authBusy.value = true;
    authFeedback.value = null;
    authStatus.value = signedOutStatus(authStatus.value);
    options.onSigningOut?.();
    try {
      const status = await desktopIpc.auth.signOut();
      if (generation !== authGeneration) return;
      authStatus.value = signedOutStatus(status);
      await options.onSignedOut();
    } catch (error) {
      if (generation !== authGeneration) return;
      authFeedback.value = error instanceof Error ? error.message : "Could not sign out.";
    } finally {
      if (generation === authGeneration) authBusy.value = false;
    }
  }

  if (getCurrentScope()) {
    onScopeDispose(() => {
      ++authGeneration;
      clearAuthPollTimer();
    });
  }

  return {
    authBusy,
    authFeedback,
    authSessionLocked,
    authStatus,
    cancelAuthFlow,
    clearAuthPollTimer,
    openVerification,
    pollAuthFlow,
    scheduleAuthPoll,
    signOut,
    startAuthFlow,
  };
}

export function signedOutStatus(status: DesktopAuthStatus | null): DesktopAuthStatus {
  return {
    authenticated: false,
    account: null,
    pendingDeviceAuth: null,
    apiUrl: status?.apiUrl || null,
    tokenStored: false,
    error: null,
  };
}
