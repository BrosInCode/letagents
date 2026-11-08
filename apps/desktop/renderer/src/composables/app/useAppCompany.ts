import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { CompanyInviteAction, CompanyInviteView } from "../../../../../../shared/ui/company-invite/types";
import { companyInviteView, isCompanyLinkId } from "../../../../../../shared/ui/company-invite/view";
import type { CompanyHomeState } from "../../components/desktop/company/types";
import type { FirstRunCompanyStepState } from "../../components/desktop/setup/types";
import { showsCompanyHome } from "../../domain/company-navigation";
import { desktopIpc } from "../../ipc/index.js";
import { useDesktopOrganizations } from "../useDesktopOrganizations";
import type { AppContextOf } from "./context";

/** The optional company the person works in, company links, and the first-run company step. */
export function useAppCompany(context: unknown) {
  const app = context as AppContextOf<"useAppRoomContext" | "useAppSetupOnboarding" | "useAppState">;
  const { authStatus, firstRunStage } = app;
  const company = useDesktopOrganizations(authStatus);
  /** The organization ID of a company link that is open now. */
  const pendingCompanyInvite = ref<string | null>(null);
  /** Set when the open link was just joined or set up, so the dialog shows its done view. */
  const inviteJustJoined = ref(false);
  let unsubscribeCompanyInvite: (() => void) | null = null;
  let companyInviteEventVersion = 0;

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

  const companyInvite = computed<CompanyInviteView | null>(() => {
    const id = pendingCompanyInvite.value;
    if (!id) return null;
    return companyInviteView({
      id,
      status: company.status.value,
      accessReason: company.accessReason.value,
      organizations: company.organizations.value,
      invitations: company.invitations.value,
      ssoRequired: company.ssoRequired.value,
      viewerLogin: authStatus.value?.account?.login ?? null,
      justJoined: inviteJustJoined.value,
      roomCount: company.selectedId.value === id && company.roomsStatus.value === "ready" ? company.rooms.value.length : null,
    });
  });

  async function completeCompanyInvite(id: string | null): Promise<void> {
    if (!id || pendingCompanyInvite.value !== id) return;
    await desktopIpc.organizations.acknowledgeInvite(id);
    if (pendingCompanyInvite.value === id) {
      pendingCompanyInvite.value = null;
      inviteJustJoined.value = false;
    }
  }

  function receiveCompanyInvite(id: string): void {
    if (!isCompanyLinkId(id)) return;
    pendingCompanyInvite.value = id;
    inviteJustJoined.value = false;
    if (firstRunStage.value === "room") firstRunStage.value = "organization";
    if (authStatus.value?.authenticated) void company.refresh();
  }

  async function chooseOnboardingCompany(id: string | null): Promise<void> {
    const invite = pendingCompanyInvite.value;
    if (await company.choose(id)) {
      await completeCompanyInvite(invite);
      app.firstRunRoomSelected.value = false;
      app.continueToRoomConfirmation();
    }
  }

  /** The company link for the selected company: a web page that opens the app. */
  async function copyCompanyLink(): Promise<void> {
    const selected = company.selected.value;
    if (!selected || !authStatus.value?.apiUrl) return;
    const url = new URL(`/company/${selected.github_org_id}`, authStatus.value.apiUrl).toString();
    try {
      await navigator.clipboard.writeText(url);
      app.pushActionToast(`${selected.login} link copied. Joining needs a GitHub membership.`, "success");
    } catch {
      app.pushActionToast("Couldn’t copy the company link.", "error");
    }
  }

  // People with no organizations, invitations or blocked organizations never
  // see the company step: setup moves on to the room step, and Back from the
  // room step returns to GitHub. A company link always shows the step.
  let previousStage = firstRunStage.value;
  watch(
    [firstRunStage, company.status, company.hasChoices],
    ([stage]) => {
      const cameFrom = previousStage;
      previousStage = stage;
      if (stage !== "organization" || company.status.value !== "ready" || company.hasChoices.value) return;
      if (pendingCompanyInvite.value) return;
      if (cameFrom === "room") firstRunStage.value = "github";
      else app.continueToRoomConfirmation();
    },
  );

  // Coming back to the window after "Allow on GitHub" (or after a while) checks
  // GitHub again. A recent check is reused, so focus changes do not flood GitHub.
  function refreshOnFocus(): void {
    void company.refreshIfStale();
  }

  // A link that arrives while the app runs wins over the one saved at launch.
  onMounted(() => {
    window.addEventListener("focus", refreshOnFocus);
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
    window.removeEventListener("focus", refreshOnFocus);
    unsubscribeCompanyInvite?.();
  });

  return {
    company, companyStep, companyInvite, pendingCompanyInvite, inviteJustJoined,
    completeCompanyInvite, receiveCompanyInvite, chooseOnboardingCompany, copyCompanyLink,
  };
}

/** The company home for a room outside the chosen company, the sidebar company switch, and the company link dialog. */
export function useAppCompanyNavigation(context: unknown) {
  const app = context as AppContextOf<"useAppCompany" | "useAppNavigation" | "useAppSidebarEntries" | "useAppSidebarSelection">;
  const { activeEntry, company, companyInvite, inviteJustJoined, pendingCompanyInvite, sidebarProjectEntries } = app;

  const showCompanyHome = computed(() => showsCompanyHome({
    activeEntry: activeEntry.value,
    selectedId: company.activeId.value,
    sidebarProjects: sidebarProjectEntries.value,
  }));

  const companyHomeState = computed<CompanyHomeState>(() => {
    if (company.status.value === "github_access_required" || company.roomsStatus.value === "github_access_required") {
      return "github_access_required";
    }
    if (company.roomsStatus.value === "sso_required") return "sso_required";
    if (company.joiningId.value || company.roomsStatus.value === "loading") return "loading";
    if ((company.status.value === "unavailable" || company.roomsStatus.value === "unavailable") && !company.rooms.value.length) {
      return "unavailable";
    }
    if (!company.rooms.value.length) return "empty";
    return "choose";
  });

  async function chooseSidebarCompany(id: string | null): Promise<void> {
    app.cancelSidebarRoomSelection();
    if (await company.choose(id)) {
      await nextTick();
      const first = sidebarProjectEntries.value.find((project) => project.parent.roomIdentifier && !project.parent.pinned);
      if (first) app.handleSidebarEntrySelected(first.parent);
    }
  }

  /** Answer a button in the company link dialog. */
  async function runCompanyInviteAction(action: CompanyInviteAction): Promise<void> {
    const id = pendingCompanyInvite.value;
    const view = companyInvite.value;
    if (!id || !view) return;
    const login = "organization" in view && view.organization ? view.organization.login : null;
    switch (action) {
      case "join":
      case "setup":
        if (await company.choose(id)) inviteJustJoined.value = true;
        return;
      case "show_rooms":
        await app.completeCompanyInvite(id);
        await chooseSidebarCompany(id);
        return;
      case "retry":
        await company.refresh();
        return;
      case "allow":
        await company.openOnGitHub({ kind: "allow" });
        return;
      case "open_invitation":
        if (login) await company.openOnGitHub({ kind: "invitation", login });
        return;
      case "authorize_sso":
        await company.openOnGitHub(login ? { kind: "sso", login } : { kind: "allow" });
        return;
      case "sign_in":
        return;
      default:
        await app.completeCompanyInvite(id);
    }
  }

  return { showCompanyHome, companyHomeState, chooseSidebarCompany, runCompanyInviteAction };
}
