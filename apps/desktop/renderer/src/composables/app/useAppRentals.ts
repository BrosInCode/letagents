import { loadRentalProviderDashboard, useRentalProviderEvents } from "../useRentalProviderEvents";
import { rentMarketplaceEntry } from "../../domain/desktop-navigation";
import { desktopIpc } from "../../ipc/index.js";
import { supervisedAgentsSupported } from "../../domain/supervised-agents-support";
import type { AppContextOf } from "./context";

/** Rent marketplace navigation and the provider's pending rental requests. */
export function useAppRentalActions(context: unknown) {
  const app = context as AppContextOf<"useAppAuthFlow" | "useAppNavigation" | "useAppState">;
  const {
    authStatus, inboxRentalError, inboxRentals, rentMarketplaceRole, rentalRequestCount,
    sessionGeneration,
  } = app;
  function openRentMarketplace(): void {
    rentMarketplaceRole.value = "renter";
    app.activeEntry.value = rentMarketplaceEntry;
  }

  function openRentalRequestInbox(): void {
    rentMarketplaceRole.value = "provider";
    app.activeEntry.value = rentMarketplaceEntry;
  }

  async function refreshRentalRequestCount(): Promise<void> {
    // Renting out needs agents from this app; where they cannot run there are no requests to check.
    if (!authStatus.value?.authenticated || app.authSessionLocked.value || !supervisedAgentsSupported.value) {
      rentalRequestCount.value = 0; inboxRentals.value = []; inboxRentalError.value = '';
      return;
    }
    if (!desktopIpc.rental?.getProviderDashboard) return;
    const generation = sessionGeneration.value;
    const accountId = authStatus.value?.account?.id;
    try {
      const dashboard = await loadRentalProviderDashboard();
      if (generation !== sessionGeneration.value || accountId !== authStatus.value?.account?.id || !authStatus.value?.authenticated) return;
      inboxRentals.value = Array.isArray(dashboard.pendingRequests) ? dashboard.pendingRequests : [];
      rentalRequestCount.value = inboxRentals.value.length; inboxRentalError.value = '';
    } catch {
      if (generation !== sessionGeneration.value || accountId !== authStatus.value?.account?.id) return;
      rentalRequestCount.value = 0; inboxRentals.value = []; inboxRentalError.value = 'Rental requests could not be checked.';
    }
  }
  return {
    openRentMarketplace, openRentalRequestInbox, refreshRentalRequestCount,
  };
}

/** Refresh the rental request count when the provider events arrive. */
export function useAppRentalEvents(context: unknown) {
  const app = context as AppContextOf<"useAppRentalActions">;
  const {
    refreshRentalRequestCount,
  } = app;
  useRentalProviderEvents(() => {
    void refreshRentalRequestCount();
  });
}
