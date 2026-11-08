import { computed, nextTick, onBeforeUnmount, onMounted, watch } from "vue";
import type { CompanyHomeState } from "../../components/desktop/company/types";
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
    // Only a company GitHub has confirmed counts as chosen.
    selectedId: company.activeId.value,
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

/** The company home shown when the active room is outside the chosen company, and the sidebar company switch. */
export function useAppCompanyNavigation(context: unknown) {
  const app = context as AppContextOf<"useAppCompany" | "useAppNavigation" | "useAppSidebarEntries" | "useAppSidebarSelection">;
  const { activeEntry, company, sidebarProjectEntries } = app;

  // Without a company the sidebar is the existing account view, so nothing replaces the room.
  const showCompanyHome = computed(() => Boolean(company.activeId.value) && activeEntry.value.type === "room"
    && !sidebarProjectEntries.value.some((project) =>
      [project.parent, ...project.branchRooms, ...project.focusRooms].some((entry) => entry.id === activeEntry.value.id && entry.roomIdentifier)
    ));

  const companyHomeState = computed<CompanyHomeState>(() => {
    if (company.status.value === "github_access_required" || company.roomsStatus.value === "github_access_required") {
      return "github_access_required";
    }
    if (company.roomsStatus.value === "sso_required") return "sso_required";
    if (company.joiningId.value || company.roomsStatus.value === "loading") return "loading";
    if (company.roomsStatus.value === "unavailable" && !company.rooms.value.length) return "unavailable";
    if (!company.rooms.value.length) return "empty";
    return "choose";
  });

  async function chooseSidebarCompany(id: string | null): Promise<void> {
    app.cancelSidebarRoomSelection();
    if (await company.choose(id)) {
      await nextTick();
      const first = sidebarProjectEntries.value.find((project) => project.parent.roomIdentifier);
      if (first) app.handleSidebarEntrySelected(first.parent);
    }
  }

  return { showCompanyHome, companyHomeState, chooseSidebarCompany };
}
