import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { desktopIpc } from "../../ipc/index.js";
import { useDesktopOrganizations } from "../useDesktopOrganizations";
import type { AppContextOf } from "./context";

/** The optional company the person works in, company invitation links, and the first-run company step. */
export function useAppCompany(context: unknown) {
  const app = context as AppContextOf<"useAppRoomContext" | "useAppSetupOnboarding" | "useAppState">;
  const { authStatus, firstRunStage } = app;
  const company = useDesktopOrganizations(authStatus);
  const pendingCompanyInvite = ref<string | null>(null);
  let unsubscribeCompanyInvite: (() => void) | null = null;
  let companyInviteEventVersion = 0;

  async function completeCompanyInvite(id: string | null): Promise<void> {
    if (!id || pendingCompanyInvite.value !== id) return;
    await desktopIpc.organizations.acknowledgeInvite(id);
    if (pendingCompanyInvite.value === id) pendingCompanyInvite.value = null;
  }

  function receiveCompanyInvite(id: string): void {
    if (!/^[1-9][0-9]*$/.test(id)) return;
    pendingCompanyInvite.value = id;
    if (firstRunStage.value === "room") firstRunStage.value = "organization";
    if (authStatus.value?.authenticated) void company.refresh();
  }

  async function chooseOnboardingCompany(id: string | null): Promise<void> {
    const invite = pendingCompanyInvite.value;
    if (await company.choose(id)) {
      await completeCompanyInvite(invite);
      if (pendingCompanyInvite.value) return;
      app.firstRunRoomSelected.value = false;
      app.continueToRoomConfirmation();
    }
  }

  async function copyCompanyLink(): Promise<void> {
    if (!company.selectedId.value || !authStatus.value?.apiUrl) return;
    const url = new URL(`/join/${company.selectedId.value}`, authStatus.value.apiUrl).toString();
    try {
      await navigator.clipboard.writeText(url);
      app.pushActionToast("Company link copied. GitHub membership is required to join.", "success");
    } catch { app.pushActionToast("Couldn’t copy the company link.", "error"); }
  }

  // A link that arrives while the app runs wins over the one saved at launch.
  onMounted(() => {
    const inviteVersion = companyInviteEventVersion;
    unsubscribeCompanyInvite = desktopIpc.organizations?.onInvited?.((id) => {
      companyInviteEventVersion += 1;
      receiveCompanyInvite(id);
    }) || null;
    void desktopIpc.organizations?.pendingInvite?.().then((id) => {
      if (id && inviteVersion === companyInviteEventVersion) receiveCompanyInvite(id);
    });
  });
  onBeforeUnmount(() => {
    unsubscribeCompanyInvite?.();
  });

  return { company, pendingCompanyInvite, completeCompanyInvite, chooseOnboardingCompany, copyCompanyLink };
}

/** The company home shown for an invitation or a room outside the chosen company, and the sidebar company switch. */
export function useAppCompanyNavigation(context: unknown) {
  const app = context as AppContextOf<"useAppCompany" | "useAppNavigation" | "useAppSidebarEntries" | "useAppSidebarSelection">;
  const { activeEntry, company, pendingCompanyInvite, sidebarProjectEntries } = app;

  const showCompanyHome = computed(() => Boolean(pendingCompanyInvite.value) || activeEntry.value.type === "room" && !sidebarProjectEntries.value.some((project) =>
    [project.parent, ...project.branchRooms, ...project.focusRooms].some((entry) => entry.id === activeEntry.value.id && entry.roomIdentifier)
  ));

  async function chooseSidebarCompany(id: string | null): Promise<void> {
    const invite = pendingCompanyInvite.value;
    app.cancelSidebarRoomSelection();
    if (await company.choose(id)) {
      await app.completeCompanyInvite(invite);
      await nextTick();
      const first = sidebarProjectEntries.value.find((project) => project.parent.roomIdentifier);
      if (first) app.handleSidebarEntrySelected(first.parent);
    }
  }

  return { showCompanyHome, chooseSidebarCompany };
}
