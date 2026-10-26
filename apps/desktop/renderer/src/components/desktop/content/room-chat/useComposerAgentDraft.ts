import { computed, reactive, ref, watch } from "vue";
import type {
  DesktopAgentProvider,
  DesktopAgentProviderId,
  DesktopAgentProviderModelsResult,
  DesktopAgentProviderPreflight,
  DesktopManagedAgentEffort,
  DesktopManagedAgentPermissionProfile,
  DesktopManagedAgentPermissionProfileId,
  DesktopSupervisorManifestEntry,
} from "../../../../../../electron/ipc-types";
import { desktopIpc } from "../../../../ipc/index.js";
import {
  branchScopedGitRoomExpectedBranch,
  hasSupervisedRuntime,
  matchingManagedAgentWorktreesForBranch,
  supervisedPermissionProfilePresentation,
  supervisedProviderLaunchPolicy,
  visibleDesktopAgentProviders,
} from "../../../../domain/managed-agents";
import { refreshSupervisedRuntimeEntry } from "../../../../domain/supervised-recovery";
import { contextualAddAgentError } from "../add-agent/add-agent-errors";
import type { SupervisorEntriesContext } from "../add-agent/supervisor-entries-context";
import { createSupervisedAgentFromSnapshot } from "../add-agent/useAddAgentController";
import {
  managedAgentEffortOptionsForProvider,
  supervisedProviderTakesEffort,
} from "../add-agent/useAddAgentPresentation";
import {
  accessStops,
  readPersonalAccess,
  rememberPersonalAccess,
  resolveAccess,
} from "./composer-agent-access";
import {
  COMPOSER_AGENT_PROVIDERS,
  composerAgentName,
  composerAgentReadiness,
  type ComposerAgentLaunchHost,
  type ComposerAgentReadiness,
} from "./composer-agent-launch";

/** The agent a chip above the input will start; the composer text is its first message. */
export interface ComposerAgentChip {
  /** Stays the same while the chip's settings change. */
  id: number;
  providerId: DesktopAgentProviderId;
  /** Null uses the provider's default model. */
  model: string | null;
  effort: DesktopManagedAgentEffort | "";
  access: DesktopManagedAgentPermissionProfileId | null;
  /** The person chose this agent's access in the chip, so a new personal default leaves it alone. */
  accessChosen: boolean;
  /** The provider lacks the personal default, so a safer level was taken. */
  fellBack: boolean;
}

export interface ComposerAgentRow {
  providerId: DesktopAgentProviderId;
  name: string;
  /** The model in grey, or "Not set up". */
  detail: string;
  /** One quiet word on the right, only when it means something. */
  hint: string;
  readiness: ComposerAgentReadiness;
}

export type ComposerAgentLaunchResult =
  | { outcome: "started"; entry: DesktopSupervisorManifestEntry }
  /** Nothing was started; the draft stays and `notice` says why. */
  | { outcome: "blocked" }
  /** The Add agent window opened to finish setup; the draft stays. */
  | { outcome: "setup" };

// The last model and effort a person chose for each provider, for this app session.
const remembered = new Map<DesktopAgentProviderId, { model: string | null; effort: DesktopManagedAgentEffort | "" }>();
let lastUsedProvider: DesktopAgentProviderId | null = null;
let chipSequence = 0;

export function useComposerAgentDraft(options: {
  roomIdentifier: () => string | null;
  host: ComposerAgentLaunchHost | null;
  supervisorEntries: SupervisorEntriesContext | null;
}) {
  const providers = ref<DesktopAgentProvider[]>([]);
  const preflights = reactive<Record<string, DesktopAgentProviderPreflight | null>>({});
  const failedChecks = reactive<Record<string, boolean>>({});
  const openModelConfigured = ref<boolean | null>(null);
  const openModelHost = ref<string | null>(null);
  const catalogs = reactive<Record<string, DesktopAgentProviderModelsResult | null>>({});
  const chip = ref<ComposerAgentChip | null>(null);
  const launching = ref(false);
  const notice = ref<string | null>(null);
  const personalAccess = ref<DesktopManagedAgentPermissionProfileId>(readPersonalAccess(viewerLogin(), options.roomIdentifier()));
  let checkVersion = 0;
  let catalogVersion = 0;
  // One id per attempt that never saved, kept only when it is unknown whether it did.
  let pendingCreationRequestId: string | null = null;

  function viewerLogin(): string | null {
    return options.host?.context().viewerLogin ?? null;
  }
  function context() {
    return options.host?.context() ?? null;
  }
  function roomOnly(): boolean {
    const current = context();
    return Boolean(current && current.roomGitRoom == null && !current.repoRootPath?.trim());
  }
  function providerById(providerId: DesktopAgentProviderId | null | undefined): DesktopAgentProvider | null {
    return providers.value.find((provider) => provider.id === providerId) ?? null;
  }
  function profilesFor(providerId: DesktopAgentProviderId): DesktopManagedAgentPermissionProfile[] {
    const hasProject = Boolean(context()?.repoRootPath?.trim());
    return (providerById(providerId)?.permissionProfiles ?? [])
      .map((profile) => supervisedPermissionProfilePresentation(providerId, profile, { hasProject }));
  }
  function readinessFor(providerId: DesktopAgentProviderId): ComposerAgentReadiness {
    return composerAgentReadiness(providerId, preflights[providerId], {
      openModelConfigured: openModelConfigured.value,
      failed: failedChecks[providerId] === true,
    });
  }
  function preflightInput(providerId: DesktopAgentProviderId, overrides: { access?: DesktopManagedAgentPermissionProfileId | null; model?: string | null; effort?: DesktopManagedAgentEffort | "" } = {}) {
    const current = context();
    return {
      roomIdentifier: options.roomIdentifier(),
      roomGitRoom: current?.roomGitRoom ?? null,
      repoRootPath: current?.repoRootPath ?? null,
      roomOnly: roomOnly(),
      permissionProfileId: overrides.access !== undefined ? overrides.access : resolveAccess(profilesFor(providerId), personalAccess.value)?.id ?? null,
      model: overrides.model ?? null,
      modelSource: overrides.model ? "provider" as const : null,
      effort: overrides.effort || null,
    };
  }

  /** Lists the providers and checks each one, for the submenu rows. Cheap to call again. */
  async function refreshProviders(): Promise<void> {
    const version = ++checkVersion;
    try {
      const listed = visibleDesktopAgentProviders(await desktopIpc.workers.listAgentProviders())
        .filter((provider) => hasSupervisedRuntime(provider) && COMPOSER_AGENT_PROVIDERS.includes(provider.id));
      if (version !== checkVersion) return;
      providers.value = listed;
    } catch {
      if (version === checkVersion) providers.value = [];
      return;
    }
    const checks: Promise<void>[] = providers.value.map(async (provider) => {
      try {
        const result = await desktopIpc.workers.runAgentProviderPreflight(provider.id, preflightInput(provider.id));
        if (version !== checkVersion) return;
        preflights[provider.id] = result;
        failedChecks[provider.id] = false;
      } catch {
        if (version === checkVersion) failedChecks[provider.id] = true;
      }
    });
    if (providerById("open-model")) checks.push(refreshOpenModelStatus(version));
    await Promise.all(checks);
  }

  async function refreshOpenModelStatus(version = checkVersion): Promise<void> {
    try {
      const status = await desktopIpc.openModel.getSettingsStatus();
      if (version !== checkVersion) return;
      openModelConfigured.value = status.configured && !status.error;
      try {
        openModelHost.value = status.configured ? new URL(status.baseUrl).host : null;
      } catch {
        openModelHost.value = null;
      }
      if (openModelConfigured.value && chip.value?.providerId === "open-model" && !chip.value.model) {
        chip.value = { ...chip.value, model: status.model || null };
      }
    } catch {
      if (version === checkVersion) openModelConfigured.value = null;
    }
  }

  const rows = computed<ComposerAgentRow[]>(() => COMPOSER_AGENT_PROVIDERS.flatMap((providerId) => {
    const provider = providerById(providerId);
    if (!provider) return [];
    const readiness = readinessFor(providerId);
    // Cursor is listed only once it can start; otherwise "Set up another agent…" covers it.
    if (providerId === "cursor" && readiness.state !== "ready") return [];
    const model = remembered.get(providerId)?.model;
    const detail = readiness.state === "not_set_up" ? "Not set up" : model ?? "Default";
    const hint = readiness.state === "setup" ? readiness.word
      : readiness.state === "checking" ? ""
        : providerId === lastUsedProvider ? "Last used" : "";
    return [{ providerId, name: composerAgentName(provider), detail, hint, readiness }];
  }));

  /**
   * Adds the chip, or opens the Add agent window when the provider must be set
   * up first. Open Model is always a chip, even before setup.
   */
  function pick(providerId: DesktopAgentProviderId): "chip" | "setup" {
    const readiness = readinessFor(providerId);
    if (readiness.state === "setup") {
      options.host?.openAddAgent({ providerId });
      return "setup";
    }
    const profiles = profilesFor(providerId);
    const resolved = resolveAccess(profiles, personalAccess.value);
    const memory = remembered.get(providerId);
    chip.value = {
      id: ++chipSequence,
      providerId,
      model: memory?.model ?? null,
      effort: supervisedProviderTakesEffort(providerId) ? memory?.effort ?? "" : "",
      access: resolved?.id ?? null,
      accessChosen: false,
      fellBack: resolved?.fellBack ?? false,
    };
    lastUsedProvider = providerId;
    notice.value = null;
    pendingCreationRequestId = null;
    void loadCatalog(providerId);
    if (providerId === "open-model") void refreshOpenModelStatus();
    return "chip";
  }

  function removeChip(): void {
    chip.value = null;
    notice.value = null;
    pendingCreationRequestId = null;
  }

  async function loadCatalog(providerId: DesktopAgentProviderId): Promise<void> {
    const version = ++catalogVersion;
    try {
      const result = await desktopIpc.workers.listAgentProviderModels(providerId, preflightInput(providerId, {
        access: chip.value?.access ?? null,
        model: chip.value?.model ?? null,
        effort: chip.value?.effort ?? "",
      }));
      if (version === catalogVersion) catalogs[providerId] = result;
    } catch {
      if (version === catalogVersion) catalogs[providerId] = null;
    }
  }

  const chipProvider = computed(() => providerById(chip.value?.providerId));
  const chipReadiness = computed(() => chip.value ? readinessFor(chip.value.providerId) : null);
  /** Model rows: the provider default, then the catalog the Add agent window uses. */
  const chipModels = computed(() => {
    const current = chip.value;
    if (!current || chipReadiness.value?.state === "not_set_up") return [];
    const catalog = catalogs[current.providerId];
    const models = (catalog?.status === "ready" ? catalog.models : []).map((option) => ({ id: option.id as string | null, label: option.label }));
    const list = [{ id: null as string | null, label: catalog?.defaultModel ? `Default (${catalog.defaultModel})` : "Default" }, ...models];
    if (current.model && !list.some((option) => option.id === current.model)) list.push({ id: current.model, label: current.model });
    return list;
  });
  const chipEfforts = computed(() => {
    const current = chip.value;
    if (!current || !supervisedProviderTakesEffort(current.providerId)) return [];
    return [{ value: "" as DesktopManagedAgentEffort | "", label: "Default" },
      ...managedAgentEffortOptionsForProvider(current.providerId).map((option) => ({ value: option.value as DesktopManagedAgentEffort, label: option.label }))];
  });
  const chipAccessStops = computed(() => chip.value ? accessStops(profilesFor(chip.value.providerId)) : []);
  /** Where the agent will work, named as the Add agent window names it. */
  const chipWorksIn = computed(() => {
    const current = context();
    const root = current?.repoRootPath?.trim();
    if (root) {
      const name = root.split(/[\\/]/).filter(Boolean).at(-1) ?? root;
      return current?.repoStatus?.branch ? `${name} · ${current.repoStatus.branch}` : name;
    }
    return roomOnly() ? "Private scratch workspace" : "No project yet";
  });
  /** The checkouts of the room's branch that the agent could work in instead, as the window offers them. */
  const chipWorktrees = computed(() => {
    const current = context();
    const providerId = chip.value?.providerId;
    if (!current || !providerId || (current.roomGitRoom && !current.gitRoomMatchesActiveRepo)) return [];
    const expected = preflights[providerId]?.branchMismatch?.expectedBranch
      || branchScopedGitRoomExpectedBranch(current.roomGitRoom, current.repoStatus);
    return matchingManagedAgentWorktreesForBranch(current.repoStatus, expected).map((worktree) => ({
      rootPath: worktree.path,
      label: `${worktree.path.split(/[\\/]/).filter(Boolean).at(-1) ?? worktree.path} · ${worktree.branch}`,
    }));
  });

  function setModel(model: string | null): void {
    if (!chip.value) return;
    chip.value = { ...chip.value, model };
    remembered.set(chip.value.providerId, { model, effort: chip.value.effort });
  }
  function setEffort(effort: DesktopManagedAgentEffort | ""): void {
    if (!chip.value) return;
    chip.value = { ...chip.value, effort };
    remembered.set(chip.value.providerId, { model: chip.value.model, effort });
  }
  function setAccess(access: DesktopManagedAgentPermissionProfileId): void {
    if (!chip.value || !chipAccessStops.value.some((profile) => profile.id === access)) return;
    chip.value = { ...chip.value, access, accessChosen: true, fellBack: false };
  }

  /** Changes this person's default for agents they start in this room. Nothing is sent to the room. */
  function setPersonalAccess(access: DesktopManagedAgentPermissionProfileId): void {
    personalAccess.value = access;
    rememberPersonalAccess(viewerLogin(), options.roomIdentifier(), access);
    const current = chip.value;
    if (current && !current.accessChosen) {
      const resolved = resolveAccess(profilesFor(current.providerId), access);
      chip.value = { ...current, access: resolved?.id ?? null, fellBack: resolved?.fellBack ?? false };
    }
  }

  watch(() => [viewerLogin(), options.roomIdentifier()] as const, ([login, room], previous) => {
    personalAccess.value = readPersonalAccess(login, room);
    // A chip belongs to the room it was added in.
    if (previous && previous[1] !== room) removeChip();
  });

  /**
   * Starts the chip's agent with `text` as its first message, through the same
   * supervised create the Add agent window uses. The draft is the caller's to
   * clear, and only after "started".
   */
  async function launch(text: string): Promise<ComposerAgentLaunchResult> {
    const current = chip.value;
    const roomIdentifier = options.roomIdentifier();
    const charter = text.trim();
    if (!current || !roomIdentifier || !charter || launching.value) return { outcome: "blocked" };
    const provider = providerById(current.providerId);
    const name = composerAgentName(provider);
    if (!provider || !options.host) {
      options.host?.openAddAgent({ providerId: current.providerId });
      return { outcome: "setup" };
    }
    if (current.providerId === "open-model" && openModelConfigured.value !== true) {
      await refreshOpenModelStatus();
      // The refresh above may have changed it.
      if ((openModelConfigured.value as boolean | null) !== true) {
        notice.value = "Configure Open Model before this agent can start. Your message is still here.";
        return { outcome: "blocked" };
      }
    }
    const launchContext = options.host.context();
    if (!launchContext.repoRootPath?.trim() && !roomOnly()) {
      notice.value = "Connect this room to its local project before adding an agent.";
      return { outcome: "blocked" };
    }
    // The click-time choices are sent as they were; only removing the chip or leaving the room cancels.
    const chipId = current.id;
    const isCurrent = () => chip.value?.id === chipId && options.roomIdentifier() === roomIdentifier;
    launching.value = true;
    notice.value = null;
    let creationRequestId: string | null = null;
    try {
      const preflight = await desktopIpc.workers.runAgentProviderPreflight(current.providerId,
        preflightInput(current.providerId, { access: current.access, model: current.model, effort: current.effort }));
      if (!isCurrent()) return { outcome: "blocked" };
      preflights[current.providerId] = preflight;
      if (!preflight.canStart) {
        if (current.providerId === "open-model" && preflight.status === "config_required") {
          notice.value = "Configure Open Model before this agent can start. Your message is still here.";
          return { outcome: "blocked" };
        }
        options.host.openAddAgent({ providerId: current.providerId });
        return { outcome: "setup" };
      }
      if (launchContext.roomStorageMode !== "local") {
        const storage = await desktopIpc.supervisorGrant.getStorageStatus();
        if (!isCurrent()) return { outcome: "blocked" };
        if (!storage.available) {
          notice.value = storage.detail;
          return { outcome: "blocked" };
        }
      }
      creationRequestId = pendingCreationRequestId ||= window.crypto.randomUUID();
      const entry = await createSupervisedAgentFromSnapshot(desktopIpc.supervisor, {
        creationRequestId,
        providerId: current.providerId,
        providerName: provider.name,
        roomIdentifier,
        repoRootPath: launchContext.repoRootPath,
        charter,
        permissionProfileId: current.access,
        launchPolicy: supervisedProviderLaunchPolicy(current.providerId, current.access),
        model: current.model,
        reasoningEffort: current.effort || null,
      }, isCurrent);
      if (!entry) return { outcome: "blocked" };
      return started(entry);
    } catch (error) {
      if (!creationRequestId) {
        notice.value = contextualAddAgentError(`Couldn't start ${name}`, error, "Your message is still here. Try again.");
        return { outcome: "blocked" };
      }
      // The create may have been saved before the error reached us.
      const lookup = await refreshSupervisedRuntimeEntry(desktopIpc.supervisor, roomIdentifier, `supervised_${creationRequestId}`);
      if (lookup.entry) return started(lookup.entry);
      if (!lookup.error) pendingCreationRequestId = null;
      notice.value = contextualAddAgentError(`Couldn't start ${name}`, error, "Your message is still here. Try again.");
      return { outcome: "blocked" };
    } finally {
      launching.value = false;
    }

    function started(entry: DesktopSupervisorManifestEntry): ComposerAgentLaunchResult {
      pendingCreationRequestId = null;
      if (chip.value?.id === chipId) chip.value = null;
      void options.supervisorEntries?.refresh();
      return { outcome: "started", entry };
    }
  }

  return {
    providers,
    rows,
    chip,
    chipProvider,
    chipReadiness,
    chipModels,
    chipEfforts,
    chipAccessStops,
    chipWorksIn,
    chipWorktrees,
    openModelHost,
    launching,
    notice,
    personalAccess,
    refreshProviders,
    refreshOpenModelStatus: () => refreshOpenModelStatus(),
    pick,
    removeChip,
    setModel,
    setEffort,
    setAccess,
    setPersonalAccess,
    launch,
  };
}
