import { computed, nextTick } from "vue";
import { useDesktopOrganizations } from "../useDesktopOrganizations";
import type { AppContextOf } from "./context";

/** The optional company the person works in, and the first-run company step. */
export function useAppCompany(context: unknown) {
  const app = context as AppContextOf<"useAppState" | "useAppSetupOnboarding">;
  const company = useDesktopOrganizations(app.authStatus);

  async function chooseOnboardingCompany(id: string | null): Promise<void> {
    if (await company.choose(id)) {
      app.firstRunRoomSelected.value = false;
      app.continueToRoomConfirmation();
    }
  }

  return { company, chooseOnboardingCompany };
}

/** The company home shown when the active room is outside the chosen company, and the sidebar company switch. */
export function useAppCompanyNavigation(context: unknown) {
  const app = context as AppContextOf<"useAppCompany" | "useAppNavigation" | "useAppSidebarEntries" | "useAppSidebarSelection">;
  const { activeEntry, company, sidebarProjectEntries } = app;

  const showCompanyHome = computed(() => activeEntry.value.type === "room" && !sidebarProjectEntries.value.some((project) =>
    [project.parent, ...project.branchRooms, ...project.focusRooms].some((entry) => entry.id === activeEntry.value.id && entry.roomIdentifier)
  ));

  async function chooseSidebarCompany(id: string | null): Promise<void> {
    app.cancelSidebarRoomSelection();
    if (await company.choose(id)) {
      await nextTick();
      const first = sidebarProjectEntries.value.find((project) => project.parent.roomIdentifier);
      if (first) app.handleSidebarEntrySelected(first.parent);
    }
  }

  return { showCompanyHome, chooseSidebarCompany };
}
