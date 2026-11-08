import { computed, ref, watch, type Ref } from "vue";
import type { DesktopAuthStatus } from "../../../electron/ipc-types/auth.js";
import type {
  DesktopGitHubAccessReason,
  DesktopOrganization,
  DesktopOrganizationGitHubPage,
  DesktopOrganizationInvitation,
  DesktopOrganizationRoom,
  DesktopOrganizationSsoBlock,
} from "../../../electron/ipc-types/organizations.js";
import { desktopIpc } from "../ipc/index.js";

/** Where the list of the person's GitHub organizations stands. */
export type CompanyListStatus = "idle" | "loading" | "ready" | "github_access_required" | "unavailable";
/** Where the selected company's room list stands. */
export type CompanyRoomsStatus = "idle" | "loading" | "ready" | "sso_required" | "github_access_required" | "unavailable";

/** A window-focus refresh runs at most once in this time. */
export const COMPANY_REFRESH_INTERVAL_MS = 60_000;

export function useDesktopOrganizations(auth: Ref<DesktopAuthStatus | null>) {
  const organizations = ref<DesktopOrganization[]>([]);
  const invitations = ref<DesktopOrganizationInvitation[]>([]);
  const ssoRequired = ref<DesktopOrganizationSsoBlock[]>([]);
  const status = ref<CompanyListStatus>("idle");
  const accessReason = ref<DesktopGitHubAccessReason | null>(null);
  const rooms = ref<DesktopOrganizationRoom[]>([]);
  const roomsStatus = ref<CompanyRoomsStatus>("idle");
  const selectedId = ref<string | null>(null);
  /** The organization that a join or setup is running for. */
  const joiningId = ref<string | null>(null);
  const error = ref<string | null>(null);
  const selected = computed(() => organizations.value.find((org) => org.github_org_id === selectedId.value) ?? null);
  const busy = computed(() => status.value === "loading" || joiningId.value !== null);
  /** Whether the person has anything to choose or act on: a company, an invitation, or a blocked organization. */
  const hasChoices = computed(() => Boolean(organizations.value.length || invitations.value.length || ssoRequired.value.length));
  const accountKey = computed(() => auth.value?.authenticated && auth.value.account
    ? `letagents:company:${auth.value.apiUrl}:${auth.value.account.id}` : null);
  let generation = 0;
  let lastRefreshAt = 0;

  function persist(): void {
    if (!accountKey.value) return;
    try {
      if (selectedId.value) window.localStorage.setItem(accountKey.value, selectedId.value);
      else window.localStorage.removeItem(accountKey.value);
    } catch { /* Selection still works when local storage is unavailable. */ }
  }

  function leaveCompany(): void {
    selectedId.value = null;
    rooms.value = [];
    roomsStatus.value = "idle";
    persist();
  }

  function needGitHubAccess(reason: DesktopGitHubAccessReason): void {
    status.value = "github_access_required";
    accessReason.value = reason;
  }

  /** Load the rooms of the selected company. Rooms already shown stay while the check runs, so nothing flickers. */
  async function loadRooms(id: string, request: number): Promise<boolean> {
    if (!rooms.value.length) roomsStatus.value = "loading";
    const result = await desktopIpc.organizations.rooms(id);
    if (request !== generation) return false;
    if (result.status === "ok") {
      rooms.value = result.rooms;
      roomsStatus.value = "ready";
      return true;
    }
    if (result.status === "membership_required") {
      leaveCompany();
      error.value = "Your GitHub account is no longer a member of that company.";
      return false;
    }
    if (result.status === "github_access_required") needGitHubAccess(result.reason);
    // A room list that GitHub cannot confirm is not shown.
    if (result.status !== "unavailable") rooms.value = [];
    roomsStatus.value = result.status === "github_access_required" ? "github_access_required" : result.status;
    return false;
  }

  async function refresh(): Promise<void> {
    if (!accountKey.value) return;
    const request = ++generation;
    lastRefreshAt = Date.now();
    if (status.value !== "ready") status.value = "loading";
    error.value = null;
    try {
      const result = await desktopIpc.organizations.list();
      if (request !== generation) return;
      if (result.status !== "ok") {
        if (result.status === "github_access_required") needGitHubAccess(result.reason);
        else status.value = "unavailable";
        return;
      }
      organizations.value = result.organizations;
      invitations.value = result.invitations;
      ssoRequired.value = result.ssoRequired;
      status.value = "ready";
      accessReason.value = null;
      if (selectedId.value && !result.organizations.some((org) => org.github_org_id === selectedId.value && org.joined)) {
        leaveCompany();
        return;
      }
      if (selectedId.value) await loadRooms(selectedId.value, request);
    } catch {
      if (request === generation) status.value = "unavailable";
    }
  }

  /** The window-focus refresh: skip it when the last check is recent, so GitHub is not asked on every focus. */
  async function refreshIfStale(maxAgeMs = COMPANY_REFRESH_INTERVAL_MS): Promise<void> {
    // A list that is not ready yet (after "Allow on GitHub", or after GitHub did
    // not answer) is checked again at once.
    if (status.value === "ready" && Date.now() - lastRefreshAt < maxAgeMs) return;
    if (status.value === "loading") return;
    await refresh();
  }

  async function choose(id: string | null): Promise<boolean> {
    if (!accountKey.value) return false;
    if (id === null) {
      generation += 1;
      joiningId.value = null;
      error.value = null;
      leaveCompany();
      return true;
    }
    if (joiningId.value) return false;
    const org = organizations.value.find((item) => item.github_org_id === id);
    if (!org || (!org.setup && org.role !== "owner")) {
      error.value = "An owner needs to set this company up in LetAgents first.";
      return false;
    }
    const request = ++generation;
    joiningId.value = id;
    error.value = null;
    try {
      if (!org.joined) {
        const joined = await desktopIpc.organizations.join(id, !org.setup);
        if (request !== generation) return false;
        if (joined.status !== "ok") {
          if (joined.status === "github_access_required") needGitHubAccess(joined.reason);
          else error.value = joinErrorText(joined.status, org.login);
          return false;
        }
        org.setup = true;
        org.joined = true;
      }
      if (selectedId.value !== id) rooms.value = [];
      selectedId.value = id;
      persist();
      await loadRooms(id, request);
      return request === generation && selectedId.value === id;
    } catch {
      if (request === generation) error.value = "GitHub didn’t answer, so LetAgents couldn’t open this company. Try again.";
      return false;
    } finally {
      if (request === generation) joiningId.value = null;
    }
  }

  /** List a room just created in the selected company at once, before the next check with GitHub. */
  function rememberCreatedRoom(room: { roomIdentifier: string; displayName: string; organizationId: string }): void {
    if (room.organizationId !== selectedId.value) return;
    if (rooms.value.some((entry) => entry.room_id.toLowerCase() === room.roomIdentifier.toLowerCase())) return;
    rooms.value = [...rooms.value, {
      kind: "room", room_id: room.roomIdentifier, display_name: room.displayName,
      full_name: null, github_repo_id: null, organization_id: room.organizationId, visibility: null,
    }];
  }

  async function openOnGitHub(page: DesktopOrganizationGitHubPage): Promise<void> {
    await desktopIpc.organizations.openOnGitHub(page);
  }

  watch(accountKey, () => {
    generation += 1;
    organizations.value = [];
    invitations.value = [];
    ssoRequired.value = [];
    rooms.value = [];
    status.value = "idle";
    roomsStatus.value = "idle";
    accessReason.value = null;
    selectedId.value = null;
    joiningId.value = null;
    error.value = null;
    lastRefreshAt = 0;
    if (accountKey.value) {
      try { selectedId.value = window.localStorage.getItem(accountKey.value); } catch { /* Optional preference. */ }
      void refresh();
    }
  }, { immediate: true, flush: "sync" });

  return {
    organizations, invitations, ssoRequired, status, accessReason, rooms, roomsStatus,
    selectedId, selected, joiningId, busy, error, hasChoices,
    refresh, refreshIfStale, choose, openOnGitHub, rememberCreatedRoom,
  };
}

function joinErrorText(status: "membership_required" | "owner_required" | "setup_required" | "unavailable", login: string): string {
  if (status === "membership_required") return `Your GitHub account isn’t a member of ${login}. Ask an owner to add you on GitHub.`;
  if (status === "owner_required" || status === "setup_required") return `An owner of ${login} needs to set it up in LetAgents first.`;
  return "GitHub didn’t answer, so LetAgents couldn’t open this company. Try again.";
}
