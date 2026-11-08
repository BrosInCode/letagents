import { computed, onBeforeUnmount, onMounted, watch } from "vue";
import type { FirstRunCompanyStepState } from "../../components/desktop/setup/types";
import { useDesktopOrganizations } from "../useDesktopOrganizations";
import type { AppContextOf } from "./context";

/** The optional company the person works in, and the first-run company step. */
export function useAppCompany(context: unknown) {
  const app = context as AppContextOf<"useAppState" | "useAppSetupOnboarding">;
  const { firstRunStage } = app;
  const company = useDesktopOrganizations(app.authStatus);

  const companyStep = computed<FirstRunCompanyStepState>(() => ({
    status: company.status.value,
    accessReason: company.accessReason.value,
    organizations: company.organizations.value,
    invitations: company.invitations.value,
    ssoRequired: company.ssoRequired.value,
    error: company.error.value,
    selectedId: company.selectedId.value,
    joiningId: company.joiningId.value,
  }));

  async function chooseOnboardingCompany(id: string | null): Promise<void> {
    if (await company.choose(id)) {
      app.firstRunRoomSelected.value = false;
      app.continueToRoomConfirmation();
    }
  }

  // People with no organizations, invitations or blocked organizations never
  // see the company step: setup moves on to the room step, and Back from the
  // room step returns to GitHub.
  let previousStage = firstRunStage.value;
  watch(
    [firstRunStage, company.status, company.hasChoices],
    ([stage]) => {
      const cameFrom = previousStage;
      previousStage = stage;
      if (stage !== "organization" || company.status.value !== "ready" || company.hasChoices.value) return;
      if (cameFrom === "room") firstRunStage.value = "github";
      else app.continueToRoomConfirmation();
    },
  );

  // Coming back to the window after "Allow on GitHub" (or after a while) checks
  // GitHub again. A recent check is reused, so focus changes do not flood GitHub.
  function refreshOnFocus(): void {
    void company.refreshIfStale();
  }
  onMounted(() => window.addEventListener("focus", refreshOnFocus));
  onBeforeUnmount(() => window.removeEventListener("focus", refreshOnFocus));

  return { company, companyStep, chooseOnboardingCompany };
}
