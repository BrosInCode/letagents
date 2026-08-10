import { onActivated, onBeforeUnmount, onDeactivated, onMounted } from "vue";

import type { DesktopRentalProviderDashboard, DesktopRentalProviderEvent } from "../../../electron/ipc-types";
import { desktopIpc } from "../ipc/index.js";

let dashboardRequest: Promise<DesktopRentalProviderDashboard> | null = null;
const DASHBOARD_REQUEST_TIMEOUT_MS = 15_000;

/** Coalesce a single provider event across the app badge, inbox and dashboard. */
export function loadRentalProviderDashboard(
  timeoutMs = DASHBOARD_REQUEST_TIMEOUT_MS,
): Promise<DesktopRentalProviderDashboard> {
  if (dashboardRequest) return dashboardRequest;
  const bridge = desktopIpc.rental;
  if (!bridge?.getProviderDashboard) {
    return Promise.reject(new Error("Restart LetAgents Desktop to use renting."));
  }
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const request = Promise.race([
    bridge.getProviderDashboard(),
    new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("Rental dashboard refresh timed out.")), timeoutMs);
    }),
  ]);
  const tracked = request.finally(() => {
    if (timeout) clearTimeout(timeout);
    if (dashboardRequest === tracked) dashboardRequest = null;
  });
  dashboardRequest = tracked;
  return tracked;
}

/** Keep request surfaces fresh without teaching each view about IPC cleanup. */
export function useRentalProviderEvents(
  onEvent: (event: DesktopRentalProviderEvent) => void,
): void {
  let unsubscribe: (() => void) | null = null;
  const subscribe = () => {
    if (unsubscribe) return;
    unsubscribe = desktopIpc.rental?.onProviderEvent?.(onEvent) ?? null;
  };
  const unsubscribeNow = () => {
    unsubscribe?.();
    unsubscribe = null;
  };
  onMounted(subscribe);
  onActivated(subscribe);
  onDeactivated(unsubscribeNow);
  onBeforeUnmount(unsubscribeNow);
}
