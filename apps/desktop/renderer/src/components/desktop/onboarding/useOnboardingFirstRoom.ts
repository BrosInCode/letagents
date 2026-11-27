import { ref, type Ref } from "vue";
import type { AgentAvatar } from "../../../../../../../src/shared/agent-avatar";
import type {
  DesktopAgentProvider,
  DesktopAgentProviderId,
  DesktopAgentProviderPreflight,
  DesktopManagedAgentPermissionProfile,
  DesktopRoomSnapshot,
} from "../../../../../electron/ipc-types";
import {
  hasSupervisedRuntime,
  managedAgentPermissionProfileSelectionForProvider,
  supervisedPermissionProfilePresentation,
  supervisedProviderLaunchPolicy,
} from "../../../domain/managed-agents";
import { desktopIpc } from "../../../ipc/index.js";
import { contextualAddAgentError } from "../content/add-agent/add-agent-errors";
import { createSupervisedAgentFromSnapshot } from "../content/add-agent/useAddAgentController";
import { onboardingProviderName, onboardingStateFromPreflight, onboardingUnavailableText } from "./useOnboardingAgents";

export type FirstRoomTask = "connect" | "room" | "agent";
export type FirstRoomState = "idle" | "running" | "done" | "failed";

// Add Agent's new-agent identity. It is set inline in
// content/add-agent/useAgentSetupPresentation.ts (the watch on `open`), so it
// cannot be imported; keep these two in step with that file.
export const ONBOARDING_AGENT_DEFAULT_NAME = "Atlas";
export const ONBOARDING_AGENT_DEFAULT_AVATAR: AgentAvatar = { kind: "character", character: "orbit", color: "sage" };
export const ONBOARDING_ROOM_NAME = "Welcome";
/**
 * The first agent's first message. The room shows it as the person's own first message, so it is
 * written in their voice. It asks what LetAgents is, so the agent's hello explains that first.
 * (The managed-room rules reach the agent separately on each turn.)
 */
export const ONBOARDING_AGENT_CHARTER =
  "Hi! I just set up LetAgents. In a sentence or two, what is LetAgents, and how can you help me get started here?";

export interface FirstRoomRunInput {
  providerId: DesktopAgentProviderId;
  /** Used for the first room only: a room that exists already keeps its company. */
  organizationId: string | null;
}

export interface FirstRoomOptions {
  /**
   * Where this account's setup progress is kept (see firstRoomProgressKey). With a key, a quit
   * or a reload between tries reuses the same room and agent request instead of making new ones.
   */
  storageKey?: () => string | null;
}

/** What setup keeps between app runs, per account. */
export interface FirstRoomProgress {
  roomIdentifier: string;
  organizationId: string | null;
  creation: { providerId: DesktopAgentProviderId; id: string } | null;
}

export function firstRoomProgressKey(auth: { authenticated?: boolean; apiUrl?: string | null; account?: { id?: string | number | null } | null } | null | undefined): string | null {
  const id = auth?.authenticated ? auth.account?.id : null;
  return id === null || id === undefined || id === "" ? null : `letagents-desktop:onboarding-first-room:${auth?.apiUrl ?? ""}:${id}`;
}

function readProgress(key: string | null): FirstRoomProgress | null {
  if (!key) return null;
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<FirstRoomProgress> | null;
    if (!value || typeof value.roomIdentifier !== "string" || !value.roomIdentifier) return null;
    const organizationId = typeof value.organizationId === "string" ? value.organizationId : null;
    const creation = value.creation && typeof value.creation.id === "string" && typeof value.creation.providerId === "string"
      ? { providerId: value.creation.providerId, id: value.creation.id }
      : null;
    return { roomIdentifier: value.roomIdentifier, organizationId, creation };
  } catch {
    return null;
  }
}

function writeProgress(key: string | null, progress: FirstRoomProgress | null): void {
  if (!key) return;
  try {
    if (progress) globalThis.localStorage?.setItem(key, JSON.stringify(progress));
    else globalThis.localStorage?.removeItem(key);
  } catch { /* Setup still works; a quit between tries then starts over. */ }
}

/**
 * The access profile Add Agent picks for a new agent in a room with no
 * project (useAddAgentConfiguration's syncPermissionProfileSelection and
 * useAddAgentPresentation's selectedPermissionProfile), rebuilt from the same
 * exported parts: read-only when the provider offers it, else the provider's
 * usual choice (Cursor prefers sandboxed write).
 */
export function onboardingPermissionProfile(
  provider: DesktopAgentProvider,
): { profile: DesktopManagedAgentPermissionProfile | null; hasProfiles: boolean } {
  const profiles = provider.permissionProfiles.map((profile) =>
    supervisedPermissionProfilePresentation(provider.id, profile, { hasProject: false }));
  if (!profiles.length) return { profile: null, hasProfiles: false };
  const readOnly = profiles.find((profile) => profile.id === "read_only");
  const selectedId = readOnly?.id ?? managedAgentPermissionProfileSelectionForProvider(
    { ...provider, permissionProfiles: profiles },
    {},
    provider.id === "cursor" ? "sandboxed_write" : null,
  );
  const profile = profiles.find((candidate) => candidate.id === selectedId)
    ?? profiles.find((candidate) => candidate.id === provider.defaultPermissionProfileId)
    ?? profiles.find((candidate) => candidate.status === "available")
    ?? profiles[0]
    ?? null;
  return { profile, hasProfiles: true };
}

function notReadyMessage(name: string, preflight: DesktopAgentProviderPreflight): string {
  const { state, detail } = onboardingStateFromPreflight(preflight);
  if (state === "signin") return `${name} is not signed in. Sign in, then try again.`;
  if (state === "missing") return `${name} is not installed on this Mac. Install it, then try again.`;
  return onboardingUnavailableText(name, detail);
}

/** Thrown for a step that failed for a reason we can say plainly. */
class FirstRoomStepError extends Error {}

/**
 * "Setting up your room.": connect the chosen agent app, create the Welcome
 * room, start the first agent in it. A retry keeps the room and the agent's
 * creation request id, so it never makes a second room or a second agent.
 */
export function useOnboardingFirstRoom(options: FirstRoomOptions = {}) {
  const state = ref<FirstRoomState>("idle");
  const task = ref<FirstRoomTask | null>(null);
  const error = ref<string | null>(null);
  // The snapshot is null for a room restored from an earlier run.
  const room = ref<{ roomIdentifier: string; snapshot: DesktopRoomSnapshot | null } | null>(null) as Ref<
    { roomIdentifier: string; snapshot: DesktopRoomSnapshot | null } | null
  >;
  const agent = ref<{ displayName: string; avatar: AgentAvatar | null } | null>(null) as Ref<
    { displayName: string; avatar: AgentAvatar | null } | null
  >;

  let running: Promise<boolean> | null = null;
  let resetPending = false;
  // Survive a failed run (and, with a storage key, a quit), so Retry converges on the same room and agent.
  let roomOrganizationId: string | null = null;
  let roomNamed = false;
  let creation: { providerId: DesktopAgentProviderId; roomIdentifier: string; id: string } | null = null;
  let agentCreated = false;
  // The account a run started for: a sign-out mid-run never writes into the next account's progress.
  let runKey: string | null = null;

  function save(): void {
    if (!room.value || resetPending) return;
    writeProgress(runKey, {
      roomIdentifier: room.value.roomIdentifier,
      organizationId: roomOrganizationId,
      creation: creation ? { providerId: creation.providerId, id: creation.id } : null,
    });
  }

  /** A room from an earlier run of the app: use it again, with the same agent request. */
  function restore(): void {
    if (room.value) return;
    const saved = readProgress(runKey);
    if (!saved) return;
    room.value = { roomIdentifier: saved.roomIdentifier, snapshot: null };
    roomOrganizationId = saved.organizationId;
    roomNamed = false;
    creation = saved.creation ? { ...saved.creation, roomIdentifier: saved.roomIdentifier } : null;
    agentCreated = false;
  }

  function prepare(providerId: DesktopAgentProviderId): void {
    if (agentCreated || state.value === "running") return;
    void providerId; // Every provider starts with Add Agent's default identity.
    agent.value = { displayName: ONBOARDING_AGENT_DEFAULT_NAME, avatar: { ...ONBOARDING_AGENT_DEFAULT_AVATAR } };
  }

  async function connect(providerId: DesktopAgentProviderId, roomIdentifier: string | null): Promise<DesktopAgentProvider> {
    const name = onboardingProviderName(providerId);
    let provider: DesktopAgentProvider | undefined;
    let preflight: DesktopAgentProviderPreflight;
    try {
      const listed = await desktopIpc.workers.listAgentProviders();
      provider = listed.find((candidate) => candidate.id === providerId);
      if (!provider) throw new FirstRoomStepError(`${name} is not available in this version of LetAgents.`);
      preflight = await desktopIpc.workers.runAgentProviderPreflight(providerId, {
        roomOnly: true,
        ...(roomIdentifier ? { roomIdentifier } : {}),
      });
    } catch (cause) {
      if (cause instanceof FirstRoomStepError) throw cause;
      throw new FirstRoomStepError(contextualAddAgentError(`Couldn't check ${name}`, cause, "Try again in a moment."));
    }
    if (preflight.status !== "ready" || !preflight.canStart) throw new FirstRoomStepError(notReadyMessage(name, preflight));
    return provider;
  }

  async function createRoom(organizationId: string | null): Promise<string> {
    // The company is fixed by the first try: a later try (another company chosen, or none) reuses the room.
    if (!room.value) {
      try {
        const created = await desktopIpc.room.createInviteRoom({ organizationId });
        room.value = { roomIdentifier: created.roomIdentifier, snapshot: created.snapshot };
        roomOrganizationId = organizationId;
        roomNamed = false;
        creation = null;
        agentCreated = false;
        save();
      } catch (cause) {
        throw new FirstRoomStepError(contextualAddAgentError(
          "Couldn't create your Welcome room",
          cause,
          "Check your connection and try again.",
        ));
      }
    }
    const current = room.value!;
    if (!roomNamed && typeof desktopIpc.room.rename === "function") {
      try {
        const info = await desktopIpc.room.rename(current.roomIdentifier, ONBOARDING_ROOM_NAME);
        room.value = { ...current, snapshot: current.snapshot ? { ...current.snapshot, room: info } : null };
        roomNamed = true;
      } catch {
        // The room works without its name; a retry tries the name again.
      }
    }
    return current.roomIdentifier;
  }

  async function startAgent(providerId: DesktopAgentProviderId, roomIdentifier: string): Promise<void> {
    if (agentCreated) return;
    const name = onboardingProviderName(providerId);
    // The room exists now: check the provider against it, as Add Agent does.
    const provider = await connect(providerId, roomIdentifier);
    if (!hasSupervisedRuntime(provider)) {
      throw new FirstRoomStepError(`${name} can't run as a room agent in this version of LetAgents.`);
    }
    let storage;
    try {
      storage = await desktopIpc.supervisorGrant.getStorageStatus();
    } catch (cause) {
      throw new FirstRoomStepError(contextualAddAgentError("Couldn't check secure storage", cause, "Try again in a moment."));
    }
    if (!storage.available) throw new FirstRoomStepError(storage.detail);
    const { profile, hasProfiles } = onboardingPermissionProfile(provider);
    if (hasProfiles && profile?.status !== "available") {
      throw new FirstRoomStepError(profile?.detail?.trim() || `${name} has no access setting that works in a room without a project.`);
    }
    if (!creation || creation.providerId !== providerId || creation.roomIdentifier !== roomIdentifier) {
      creation = { providerId, roomIdentifier, id: globalThis.crypto.randomUUID() };
      save();
    }
    const identity = agent.value ?? { displayName: ONBOARDING_AGENT_DEFAULT_NAME, avatar: { ...ONBOARDING_AGENT_DEFAULT_AVATAR } };
    const permissionProfileId = profile?.id ?? null;
    try {
      const entry = await createSupervisedAgentFromSnapshot(desktopIpc.supervisor, {
        creationRequestId: creation.id,
        providerId,
        providerName: provider.name || name,
        displayName: identity.displayName,
        avatar: identity.avatar,
        roomIdentifier,
        repoRootPath: null,
        charter: ONBOARDING_AGENT_CHARTER,
        permissionProfileId,
        launchPolicy: supervisedProviderLaunchPolicy(providerId, permissionProfileId),
        model: null,
        reasoningEffort: null,
      }, () => true);
      if (!entry) throw new Error("The agent was not saved.");
      agentCreated = true;
      // The background service claims a unique name; its entry owns the result.
      agent.value = { displayName: entry.displayName || identity.displayName, avatar: entry.avatar ?? identity.avatar };
    } catch (cause) {
      throw new FirstRoomStepError(contextualAddAgentError(
        `Couldn't start ${identity.displayName}`,
        cause,
        "Try again in a moment.",
      ));
    }
  }

  function run(input: FirstRoomRunInput): Promise<boolean> {
    if (running) return running;
    running = (async () => {
      state.value = "running";
      error.value = null;
      runKey = options.storageKey?.() ?? null;
      restore();
      if (!agent.value) prepare(input.providerId);
      try {
        task.value = "connect";
        await connect(input.providerId, room.value?.roomIdentifier ?? null);
        task.value = "room";
        const roomIdentifier = await createRoom(input.organizationId);
        task.value = "agent";
        await startAgent(input.providerId, roomIdentifier);
        task.value = null;
        state.value = "done";
        return true;
      } catch (cause) {
        error.value = cause instanceof FirstRoomStepError
          ? cause.message
          : contextualAddAgentError("Couldn't set up your room", cause, "Try again in a moment.");
        state.value = "failed";
        return false;
      } finally {
        running = null;
        if (resetPending) clear();
      }
    })();
    return running;
  }

  function clear(): void {
    resetPending = false;
    state.value = "idle";
    task.value = null;
    error.value = null;
    room.value = null;
    agent.value = null;
    roomOrganizationId = null;
    roomNamed = false;
    creation = null;
    agentCreated = false;
  }

  /**
   * Clears what this screen holds (another account signed in, or the person signed out). Progress
   * saved for an account stays, so that account's next run reuses its room. A reset during a run
   * waits for the run to end.
   */
  function reset(): void {
    if (running) resetPending = true;
    else clear();
  }

  /** Setup is over (the room opened, or the person skipped): drop the saved progress too. */
  function forget(): void {
    writeProgress(options.storageKey?.() ?? null, null);
    reset();
  }

  return { state, task, error, room, agent, prepare, run, reset, forget };
}

export type OnboardingFirstRoom = ReturnType<typeof useOnboardingFirstRoom>;
