import { ref, type Ref } from "vue";
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

  function clearAuthPollTimer(): void {
    if (!authPollTimer) return;
    window.clearTimeout(authPollTimer);
    authPollTimer = null;
  }

  function scheduleAuthPoll(): void {
    clearAuthPollTimer();
    const pending = authStatus.value?.pendingDeviceAuth;
    if (!pending) return;

    const waitMs = Math.max(2, pending.intervalSeconds) * 1000 + 350;
    authPollTimer = window.setTimeout(() => {
      void pollAuthFlow({ automatic: true });
    }, waitMs);
  }

  async function startAuthFlow(roomIdentifierOverride?: string | null): Promise<void> {
    if (!authStatus.value?.authenticated) authSessionLocked.value = true;
    authBusy.value = true;
    authFeedback.value = null;
    try {
      const roomIdentifier = roomIdentifierOverride === undefined
        ? options.getRoomIdentifier()
        : roomIdentifierOverride;
      const result = await desktopIpc.auth.startDeviceFlow(roomIdentifier);
      authStatus.value = result.authStatus;
      authFeedback.value = "Your code is ready. Copy it, then open GitHub to finish connecting.";
      scheduleAuthPoll();
    } catch (error) {
      authFeedback.value = error instanceof Error ? error.message : "Could not start GitHub approval.";
    } finally {
      authBusy.value = false;
    }
  }

  async function openVerification(url: string): Promise<void> {
    authBusy.value = true;
    authFeedback.value = null;
    try {
      await desktopIpc.auth.openVerification(url);
      authFeedback.value = "Use the code shown here in GitHub, then return and approve the room.";
    } catch (error) {
      authFeedback.value = error instanceof Error ? error.message : "Could not open GitHub.";
    } finally {
      authBusy.value = false;
    }
  }

  async function pollAuthFlow(optionsOverride: { automatic?: boolean } = {}): Promise<void> {
    if (!optionsOverride.automatic) {
      authBusy.value = true;
    }
    authFeedback.value = null;
    try {
      const result = await desktopIpc.auth.pollDeviceFlow();
      authStatus.value = result.authStatus;

      if (result.status === "authorized") {
        authFeedback.value = "Connected. Confirm the room and you are ready.";
        if (options.isFirstRunGate()) {
          await options.onFirstRunAuthorized();
          authSessionLocked.value = false;
          return;
        }
        await options.onAuthorized();
        authSessionLocked.value = false;
        return;
      }

      if (result.status === "pending" || result.status === "slow_down") {
        authFeedback.value = result.status === "slow_down"
          ? "GitHub asked us to slow down. LetAgents will check again shortly."
          : "Waiting for GitHub approval.";
        scheduleAuthPoll();
        return;
      }

      authFeedback.value = result.error || "GitHub approval did not complete. Start again when you are ready.";
    } catch (error) {
      authFeedback.value = error instanceof Error ? error.message : "Could not check GitHub approval.";
    } finally {
      if (!optionsOverride.automatic) {
        authBusy.value = false;
      }
    }
  }

  async function signOut(): Promise<void> {
    clearAuthPollTimer();
    authSessionLocked.value = true;
    authBusy.value = true;
    authFeedback.value = null;
    authStatus.value = signedOutStatus(authStatus.value);
    options.onSigningOut?.();
    try {
      authStatus.value = signedOutStatus(await desktopIpc.auth.signOut());
      await options.onSignedOut();
    } catch (error) {
      authFeedback.value = error instanceof Error ? error.message : "Could not sign out.";
    } finally {
      authBusy.value = false;
    }
  }

  return {
    authBusy,
    authFeedback,
    authSessionLocked,
    authStatus,
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
