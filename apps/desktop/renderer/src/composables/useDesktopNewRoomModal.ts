import { computed, ref } from "vue";
import type { DesktopRepoRoomSelection, DesktopRoomSnapshot, RepoStatus } from "../../../electron/ipc-types";
import { companyLinkIdFromInput, normalizeJoinRoomInput, validateJoinRoomInput } from "../domain/join-room-input";
import { projectRoomName } from "../domain/project-room-name";
import { repoPickerErrorMessage } from "../domain/repo-picker-error";
import { rootPathLabel, type RecentRootRoom, type RecentRootRoomKind } from "../domain/sidebar-rooms";
import { desktopIpc } from "../ipc/index.js";
import { isMembershipRefusal } from "../components/desktop/content/auth-onboarding";

export type NewRoomStep =
  | "project"
  | "new_project"
  | "standalone"
  | "join"
  | "working"
  | "error";

/** Where a blank room lives: shared online, inside the selected company (shared online), or only on this device. */
export type NewRoomStorageChoice = "cloud" | "company" | "local";

/** The company a new shared room can be created in. */
export interface NewRoomCompany {
  id: string;
  login: string;
  avatarUrl: string | null;
}
export type NewRoomActiveAction =
  | "pick_project"
  | "pick_project_parent"
  | "create_project"
  | "open_project_path"
  | "create_standalone"
  | "join"
  | null;

interface OpenRoomOptions {
  displayName?: string | null;
  kind?: RecentRootRoomKind | null;
  rootPath?: string | null;
  meta?: string | null;
}

interface DesktopNewRoomModalOptions {
  openRoomSnapshot: (snapshot: DesktopRoomSnapshot, options?: OpenRoomOptions) => void;
  finishOnboarding?: (snapshot: DesktopRoomSnapshot, dismissModal: () => void) => Promise<void> | undefined;
  setRepoStatus: (status: RepoStatus | null) => void;
  getDefaultStorageMode?: () => NewRoomStorageChoice;
  /** The company selected in the sidebar; a new shared room is created in it by default. */
  getCompany?: () => NewRoomCompany | null;
  onCreationWarning?: (message: string) => void;
  /** A pasted company link opens the company dialog instead of joining a room. */
  onCompanyLink?: (organizationId: string) => void;
  /** Called before the new company room opens, so the company lists it at once. */
  onCompanyRoomCreated?: (room: { roomIdentifier: string; displayName: string; organizationId: string }) => void;
}

export interface PendingProjectRoomSelection {
  folderLabel: string;
  repoPath: string | null;
  repoStatus: RepoStatus | null;
  roomIdentifier: string;
  roomName: string;
  snapshot: DesktopRoomSnapshot;
  source: DesktopRepoRoomSelection["source"];
  sourceLabel: string;
  warning: string | null;
}

export interface NewRoomRecentProjectFolder {
  path: string;
  label: string;
}

/** Project folders opened most recently first, one entry per folder. */
export function recentProjectFoldersFromRooms(
  rooms: readonly RecentRootRoom[],
  limit = 5,
): NewRoomRecentProjectFolder[] {
  const folders: NewRoomRecentProjectFolder[] = [];
  const seen = new Set<string>();
  for (const room of rooms) {
    const path = room.kind === "project" ? room.rootPath?.trim() : null;
    if (!path || seen.has(path)) continue;
    seen.add(path);
    folders.push({ path, label: rootPathLabel(path) || path });
    if (folders.length >= limit) break;
  }
  return folders;
}

function generateDefaultRoomName(): string {
  const stamp = new Date();
  const hh = String(stamp.getHours()).padStart(2, "0");
  const mm = String(stamp.getMinutes()).padStart(2, "0");
  return `Room ${hh}:${mm}`;
}

export function useDesktopNewRoomModal(options: DesktopNewRoomModalOptions) {
  const newRoomModalOpen = ref(false);
  const newRoomStep = ref<NewRoomStep>("standalone");
  const newRoomReturnStep = ref<Exclude<NewRoomStep, "working" | "error">>("standalone");
  const newRoomBusy = ref(false);
  const newRoomActiveAction = ref<NewRoomActiveAction>(null);
  const newRoomFeedback = ref<string | null>(null);
  const newRoomFeedbackState = ref<"info" | "error" | "success">("info");
  const newRoomJoinCode = ref("");
  const newRoomJoinError = ref<string | null>(null);
  const newRoomName = ref("");
  const newRoomStorage = ref<NewRoomStorageChoice>("cloud");
  const newRoomCompany = ref<NewRoomCompany | null>(null);
  const newRoomProjectSelection = ref<PendingProjectRoomSelection | null>(null);
  const newRoomProjectPath = ref("");
  const newRoomProjectPathError = ref<string | null>(null);
  const newRoomProjectName = ref("");
  const newRoomProjectParent = ref("");
  const newRoomProjectCreationError = ref<string | null>(null);
  const newRoomStatusMessage = ref<string | null>(null);

  const canSubmitJoin = computed(() => {
    if (options.onCompanyLink && companyLinkIdFromInput(newRoomJoinCode.value)) return true;
    const validation = validateJoinRoomInput(newRoomJoinCode.value);
    return Boolean(validation.normalized) && !validation.error;
  });
  const canSubmitStandalone = computed(() => !newRoomBusy.value);
  const newRoomCanDismiss = computed(() => !newRoomBusy.value
    || newRoomActiveAction.value === "pick_project"
    || newRoomActiveAction.value === "pick_project_parent");
  let projectRequest = 0;
  const isCurrentProjectRequest = (request: number) => request === projectRequest && newRoomModalOpen.value;

  function resetTransientState(): void {
    newRoomBusy.value = false;
    newRoomActiveAction.value = null;
    newRoomFeedback.value = null;
    newRoomFeedbackState.value = "info";
    newRoomJoinError.value = null;
    newRoomProjectPathError.value = null;
    newRoomProjectCreationError.value = null;
    newRoomStatusMessage.value = null;
  }

  function selectNewRoomEntry() {
    projectRequest += 1;
    newRoomModalOpen.value = true;
    newRoomStep.value = "standalone";
    newRoomReturnStep.value = "standalone";
    newRoomJoinCode.value = "";
    newRoomJoinError.value = null;
    newRoomName.value = "";
    newRoomCompany.value = options.getCompany?.() ?? null;
    newRoomStorage.value = options.getDefaultStorageMode?.() === "local"
      ? "local"
      : newRoomCompany.value ? "company" : "cloud";
    newRoomProjectSelection.value = null;
    newRoomProjectPath.value = "";
    newRoomProjectName.value = "";
    newRoomProjectParent.value = "";
    resetTransientState();
  }

  function closeNewRoomModal(): void {
    if (!newRoomCanDismiss.value) return;
    projectRequest += 1;
    newRoomModalOpen.value = false;
    newRoomStep.value = "standalone";
    newRoomJoinCode.value = "";
    newRoomJoinError.value = null;
    newRoomName.value = "";
    newRoomProjectSelection.value = null;
    newRoomProjectPath.value = "";
    newRoomProjectName.value = "";
    newRoomProjectParent.value = "";
    resetTransientState();
  }

  function removeProject(): void {
    if (newRoomBusy.value) return;
    newRoomProjectSelection.value = null;
    resetTransientState();
  }

  function chooseProjectIntent(): void {
    if (newRoomBusy.value) return;
    newRoomStep.value = "project";
    newRoomReturnStep.value = "project";
    resetTransientState();
  }

  function chooseStandaloneIntent(): void {
    if (newRoomBusy.value) return;
    newRoomStep.value = "standalone";
    newRoomReturnStep.value = "standalone";
    resetTransientState();
  }

  function chooseNewProjectIntent(): void {
    if (newRoomBusy.value) return;
    newRoomStep.value = "new_project";
    newRoomReturnStep.value = "new_project";
    resetTransientState();
  }

  async function pickNewProjectParent(): Promise<void> {
    if (newRoomBusy.value) return;
    const request = ++projectRequest;
    newRoomBusy.value = true;
    newRoomActiveAction.value = "pick_project_parent";
    newRoomProjectCreationError.value = null;
    try {
      const parent = await desktopIpc.repos.pickProjectParent();
      if (!isCurrentProjectRequest(request)) return;
      if (parent) newRoomProjectParent.value = parent;
    } catch (error) {
      if (!isCurrentProjectRequest(request)) return;
      newRoomProjectCreationError.value = error instanceof Error ? error.message : "LetAgents could not open the folder picker.";
    } finally {
      if (isCurrentProjectRequest(request)) {
        newRoomBusy.value = false;
        newRoomActiveAction.value = null;
      }
    }
  }

  async function createProjectRoomFromModal(): Promise<void> {
    if (newRoomBusy.value) return;
    const name = newRoomProjectName.value.trim();
    const parent = newRoomProjectParent.value.trim();
    if (!name || !parent) {
      newRoomProjectCreationError.value = "Enter a project name and choose its parent folder.";
      return;
    }
    const request = ++projectRequest;
    newRoomBusy.value = true;
    newRoomActiveAction.value = "create_project";
    newRoomProjectCreationError.value = null;
    try {
      const result = await desktopIpc.repos.createProject(parent, name);
      if (!isCurrentProjectRequest(request)) return;
      if (result.error || !result.snapshot) {
        newRoomProjectCreationError.value = repoPickerErrorMessage(result.error, "LetAgents could not create that project.");
        return;
      }
      newRoomProjectSelection.value = projectSelectionFromResult(result, result.snapshot);
      newRoomBusy.value = false;
      await confirmProjectRoomFromModal();
    } catch (error) {
      if (!isCurrentProjectRequest(request)) return;
      newRoomProjectCreationError.value = repoPickerErrorMessage(error, "LetAgents could not create that project.");
    } finally {
      if (isCurrentProjectRequest(request)) {
        newRoomBusy.value = false;
        newRoomActiveAction.value = null;
      }
    }
  }

  function chooseJoinIntent(): void {
    if (newRoomBusy.value) return;
    newRoomStep.value = "join";
    newRoomReturnStep.value = "join";
    resetTransientState();
  }

  function backFromSubstep(): void {
    if (newRoomBusy.value) return;
    if (newRoomStep.value === "error") {
      newRoomStep.value = newRoomReturnStep.value;
      resetTransientState();
      return;
    }
    chooseStandaloneIntent();
  }

  function retryLastAction(): void {
    if (newRoomBusy.value) return;
    const step = newRoomReturnStep.value;
    newRoomStep.value = step;
    resetTransientState();
    if (step === "project" && newRoomProjectSelection.value) {
      return;
    }
    if (step === "standalone") {
      void createStandaloneRoom();
      return;
    }
    if (step === "join") {
      void joinRoomCodeFromModal();
    }
  }

  async function createInviteRoom(): Promise<void> {
    newRoomStorage.value = "cloud";
    await createStandaloneRoom();
  }

  async function createLocalRoomFromModal(): Promise<void> {
    newRoomStorage.value = "local";
    await createStandaloneRoom();
  }

  async function createStandaloneRoom(): Promise<void> {
    if (newRoomBusy.value) return;
    const displayName = newRoomName.value.trim() || generateDefaultRoomName();
    newRoomName.value = displayName;
    newRoomBusy.value = true;
    newRoomActiveAction.value = "create_standalone";
    newRoomReturnStep.value = "standalone";
    newRoomStep.value = "working";
    const company = newRoomStorage.value === "company" ? newRoomCompany.value : null;
    newRoomStatusMessage.value = newRoomStorage.value === "local"
      ? "Creating local room..."
      : company ? `Creating ${company.login} room...` : "Creating shared room...";
    newRoomFeedback.value = null;
    newRoomFeedbackState.value = "info";

    try {
      if (newRoomStorage.value === "local") {
        const bridge = desktopIpc.chatStorage;
        if (!bridge?.createLocalRoom) {
          throw new Error("Restart LetAgents Desktop to enable local rooms.");
        }
        const result = await bridge.createLocalRoom({ displayName });
        await finishRoom(result.snapshot, {
          displayName,
          kind: "room",
          rootPath: null,
          meta: "Local on this device",
        });
      } else {
        const result = await desktopIpc.room.createInviteRoom(company ? { organizationId: company.id } : undefined);
        let snapshot = result.snapshot;
        let roomName =
          snapshot.room?.displayName ||
          snapshot.room?.name ||
          result.code;
        let namingWarning: string | null = null;
        const rename = desktopIpc.room.rename;
        if (rename && displayName) {
          try {
            const renamed = await rename(result.roomIdentifier, displayName);
            roomName = renamed.displayName || renamed.name || displayName;
            snapshot = {
              ...snapshot,
              room: snapshot.room
                ? {
                    ...snapshot.room,
                    displayName: roomName,
                    name: renamed.name || roomName,
                  }
                : snapshot.room,
            };
          } catch (error) {
            namingWarning =
              error instanceof Error
                ? `Room created, but renaming failed: ${error.message}`
                : "Room created, but the requested name could not be applied.";
            roomName =
              snapshot.room?.displayName ||
              snapshot.room?.name ||
              result.code;
          }
        } else if (displayName) {
          roomName = displayName;
        }
        if (company) {
          options.onCompanyRoomCreated?.({ roomIdentifier: result.roomIdentifier, displayName: roomName, organizationId: company.id });
        }
        await finishRoom(snapshot, {
          displayName: roomName,
          kind: "room",
          rootPath: null,
          meta: result.code || "Shared room",
        });
        if (snapshot.access.status !== "ready") {
          options.onCreationWarning?.(`Room created, but it couldn’t open. Invite code: ${result.code}.`);
        } else if (namingWarning) {
          options.onCreationWarning?.(namingWarning);
        }
      }
    } catch (error) {
      newRoomFeedback.value =
        error instanceof Error
          ? error.message
          : newRoomStorage.value === "local"
            ? "LetAgents could not create a local room."
            : "LetAgents could not create a shared room.";
      newRoomFeedbackState.value = "error";
      newRoomStep.value = "error";
    } finally {
      newRoomBusy.value = false;
      newRoomActiveAction.value = null;
      newRoomStatusMessage.value = null;
    }
  }

  async function openProjectRoomFromModal(): Promise<void> {
    if (newRoomBusy.value) return;
    const request = ++projectRequest;
    newRoomBusy.value = true;
    newRoomActiveAction.value = "pick_project";
    newRoomReturnStep.value = "project";
    newRoomStep.value = "project";
    newRoomFeedback.value = null;
    newRoomFeedbackState.value = "info";
    try {
      const result = await desktopIpc.repos.pickRoom();
      if (!isCurrentProjectRequest(request)) return;
      if (result.canceled) {
        newRoomStep.value = "project";
        newRoomStatusMessage.value = null;
        return;
      }
      if (result.error || !result.snapshot) {
        newRoomFeedback.value = repoPickerErrorMessage(result.error, "LetAgents could not open a room from that folder.");
        newRoomFeedbackState.value = "error";
        newRoomStep.value = "error";
        return;
      }
      newRoomProjectSelection.value = projectSelectionFromResult(result, result.snapshot);
      newRoomFeedback.value = result.warning || null;
      newRoomFeedbackState.value = result.warning ? "info" : "success";
      newRoomStep.value = "standalone";
    } catch (error) {
      if (!isCurrentProjectRequest(request)) return;
      newRoomFeedback.value = repoPickerErrorMessage(error, "LetAgents could not open the project picker.");
      newRoomFeedbackState.value = "error";
      newRoomStep.value = "error";
    } finally {
      if (isCurrentProjectRequest(request)) {
        newRoomBusy.value = false;
        newRoomActiveAction.value = null;
        newRoomStatusMessage.value = null;
      }
    }
  }

  /**
   * The typed-path twin of the folder picker, for keyboard and automation use.
   * It stays on the project step: a bad path is a field error to correct, not
   * a failure screen, and the typed text is kept.
   */
  async function openProjectRoomFromPath(folderPath?: string): Promise<void> {
    if (newRoomBusy.value) return;
    const request = ++projectRequest;
    if (folderPath !== undefined) newRoomProjectPath.value = folderPath;
    const path = newRoomProjectPath.value.trim();
    if (!path) {
      newRoomProjectPathError.value = "Enter the path to a project folder.";
      return;
    }
    newRoomBusy.value = true;
    newRoomActiveAction.value = "open_project_path";
    newRoomReturnStep.value = "project";
    newRoomProjectPathError.value = null;
    newRoomFeedback.value = null;
    newRoomFeedbackState.value = "info";
    try {
      const result = await desktopIpc.repos.openRoom(path, { newProjectRoom: true });
      if (!isCurrentProjectRequest(request)) return;
      if (result.error || !result.snapshot) {
        newRoomProjectPathError.value = repoPickerErrorMessage(result.error, "LetAgents could not open a room from that folder.");
        return;
      }
      newRoomProjectSelection.value = projectSelectionFromResult(result, result.snapshot);
      newRoomFeedback.value = result.warning || null;
      newRoomFeedbackState.value = result.warning ? "info" : "success";
      newRoomStep.value = "standalone";
    } catch (error) {
      if (!isCurrentProjectRequest(request)) return;
      newRoomProjectPathError.value = repoPickerErrorMessage(error, "LetAgents could not open that folder.");
    } finally {
      if (isCurrentProjectRequest(request)) {
        newRoomBusy.value = false;
        newRoomActiveAction.value = null;
      }
    }
  }

  async function confirmProjectRoomFromModal(): Promise<void> {
    const selection = newRoomProjectSelection.value;
    if (!selection || newRoomBusy.value) return;
    await finishRoom(selection.snapshot, {
      displayName: selection.roomName,
      kind: "project",
      rootPath: selection.repoPath,
      meta: selection.repoStatus?.branch || rootPathLabel(selection.repoPath) || selection.source || null,
    }, selection.repoStatus);
  }

  async function joinRoomCodeFromModal(): Promise<void> {
    if (newRoomBusy.value) return;
    const companyId = options.onCompanyLink ? companyLinkIdFromInput(newRoomJoinCode.value) : null;
    if (companyId) {
      newRoomJoinCode.value = "";
      newRoomJoinError.value = null;
      closeNewRoomModal();
      options.onCompanyLink?.(companyId);
      return;
    }
    const validation = validateJoinRoomInput(newRoomJoinCode.value);
    if (!validation.normalized) {
      newRoomJoinError.value = validation.error;
      newRoomFeedback.value = validation.error;
      newRoomFeedbackState.value = "error";
      return;
    }
    newRoomJoinError.value = null;
    newRoomJoinCode.value = validation.normalized;
    newRoomBusy.value = true;
    newRoomActiveAction.value = "join";
    newRoomReturnStep.value = "join";
    newRoomStep.value = "working";
    newRoomStatusMessage.value = "Joining room...";
    newRoomFeedback.value = null;
    newRoomFeedbackState.value = "info";
    try {
      const snapshot = await desktopIpc.room.getSnapshot(validation.normalized);
      if (isMembershipRefusal(snapshot.access.status)) {
        // A members-only room: open it, so its card offers the request to join
        // (or says to ask a repository admin, or for the main room's link).
        await finishRoom(snapshot, {
          displayName: snapshot.access.displayName || null,
          kind: "room",
          rootPath: null,
          meta: "Members only",
        });
        return;
      }
      if (snapshot.access.status !== "ready") {
        newRoomFeedback.value = snapshot.access.message || "You do not have access to that room.";
        newRoomFeedbackState.value = "error";
        newRoomStep.value = "error";
        return;
      }
      await finishRoom(snapshot, {
        kind: "room",
        rootPath: null,
        meta: snapshot.room?.code || "Joined room",
      });
    } catch (error) {
      newRoomFeedback.value = error instanceof Error ? error.message : "LetAgents could not join that room.";
      newRoomFeedbackState.value = "error";
      newRoomStep.value = "error";
    } finally {
      newRoomBusy.value = false;
      newRoomActiveAction.value = null;
      newRoomStatusMessage.value = null;
    }
  }

  async function finishRoom(snapshot: DesktopRoomSnapshot, openOptions: OpenRoomOptions, repoStatus?: RepoStatus | null): Promise<void> {
    if (repoStatus) options.setRepoStatus(repoStatus);
    options.openRoomSnapshot(snapshot, openOptions);

    let dismissed = false;
    const dismissModal = () => {
      if (dismissed) return;
      dismissed = true;
      newRoomBusy.value = false;
      closeNewRoomModal();
    };
    try {
      const finishingSetup = options.finishOnboarding?.(snapshot, dismissModal);
      if (finishingSetup) {
        newRoomBusy.value = true;
        await finishingSetup;
      }
    } finally {
      dismissModal();
    }
  }

  return {
    backFromSubstep,
    canSubmitJoin,
    canSubmitStandalone,
    chooseJoinIntent,
    chooseNewProjectIntent,
    chooseProjectIntent,
    chooseStandaloneIntent,
    closeNewRoomModal,
    confirmProjectRoomFromModal,
    newRoomCompany,
    createInviteRoom,
    createLocalRoomFromModal,
    createProjectRoomFromModal,
    createStandaloneRoom,
    joinRoomCodeFromModal,
    newRoomActiveAction,
    newRoomBusy,
    newRoomCanDismiss,
    newRoomFeedback,
    newRoomFeedbackState,
    newRoomJoinCode,
    newRoomJoinError,
    newRoomModalOpen,
    newRoomName,
    newRoomProjectPath,
    newRoomProjectPathError,
    newRoomProjectName,
    newRoomProjectParent,
    newRoomProjectCreationError,
    newRoomProjectSelection,
    newRoomStatusMessage,
    newRoomStep,
    newRoomStorage,
    openProjectRoomFromModal,
    openProjectRoomFromPath,
    pickNewProjectParent,
    removeProject,
    retryLastAction,
    selectNewRoomEntry,
  };
}

function projectSelectionFromResult(
  result: DesktopRepoRoomSelection,
  snapshot: DesktopRoomSnapshot
): PendingProjectRoomSelection {
  const roomIdentifier = snapshot.room?.identifier || snapshot.roomIdentifier || result.roomIdentifier || "Room";
  const roomName = projectRoomName({ roomIdentifier, gitRoom: snapshot.room?.gitRoom, rootPath: result.repoPath,
    fallback: snapshot.room?.displayName || snapshot.room?.name || roomIdentifier });
  return {
    folderLabel: rootPathLabel(result.repoPath) || result.repoPath || "Selected project folder",
    repoPath: result.repoPath,
    repoStatus: result.repoStatus,
    roomIdentifier,
    roomName,
    snapshot,
    source: result.source,
    sourceLabel: projectRoomSourceLabel(result.source),
    warning: result.warning,
  };
}

function projectRoomSourceLabel(source: DesktopRepoRoomSelection["source"]): string {
  if (source === "configured") return ".letagents.json";
  if (source === "git_remote") return "Git remote";
  if (source === "local_git") return "Local Git Room";
  if (source === "local_folder") return "Local folder";
  return "Project folder";
}
