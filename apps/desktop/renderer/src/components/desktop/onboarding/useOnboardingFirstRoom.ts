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
import { defaultSupervisedCharter } from "../content/add-agent/useAddAgentConfiguration";
import { createSupervisedAgentFromSnapshot } from "../content/add-agent/useAddAgentController";
import { onboardingProviderName, onboardingStateFromPreflight } from "./useOnboardingAgents";

export type FirstRoomTask = "connect" | "room" | "agent";
export type FirstRoomState = "idle" | "running" | "done" | "failed";

// Add Agent's new-agent identity. It is set inline in
// content/add-agent/useAgentSetupPresentation.ts (the watch on `open`), so it
// cannot be imported; keep these two in step with that file.
export const ONBOARDING_AGENT_DEFAULT_NAME = "Atlas";
export const ONBOARDING_AGENT_DEFAULT_AVATAR: AgentAvatar = { kind: "character", character: "orbit", color: "sage" };
export const ONBOARDING_ROOM_NAME = "Welcome";
/**
 * The first agent's first message. A new person meets LetAgents through this agent, so its
 * hello says what LetAgents is, in plain words, before anything else.
 */
export const ONBOARDING_AGENT_CHARTER = [
  defaultSupervisedCharter,
  "This is the person's Welcome room, and you are their first agent in LetAgents.",
  "LetAgents is a place where a team and its agents work together: each room holds the conversation, the agents, a task board and shared memory.",
  "Say hello now in under 60 words: explain in one or two plain sentences what LetAgents is, then offer to help them start (open a project folder as a room, invite a teammate, or give you a first task).",
  "Later, answer questions about LetAgents first and plainly, then help with their work.",
].join(" ");

export interface FirstRoomRunInput {
  providerId: DesktopAgentProviderId;
  organizationId: string | null;
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
  return `${name} can't start yet: ${detail}`;
}

/** Thrown for a step that failed for a reason we can say plainly. */
class FirstRoomStepError extends Error {}

/**
 * "Setting up your room.": connect the chosen agent app, create the Welcome
 * room, start the first agent in it. A retry keeps the room and the agent's
 * creation request id, so it never makes a second room or a second agent.
 */
export function useOnboardingFirstRoom() {
  const state = ref<FirstRoomState>("idle");
  const task = ref<FirstRoomTask | null>(null);
  const error = ref<string | null>(null);
  const room = ref<{ roomIdentifier: string; snapshot: DesktopRoomSnapshot } | null>(null) as Ref<
    { roomIdentifier: string; snapshot: DesktopRoomSnapshot } | null
  >;
  const agent = ref<{ displayName: string; avatar: AgentAvatar | null } | null>(null) as Ref<
    { displayName: string; avatar: AgentAvatar | null } | null
  >;

  let running: Promise<boolean> | null = null;
  // Survive a failed run, so Retry converges on the same room and agent.
  let roomOrganizationId: string | null | undefined;
  let roomNamed = false;
  let creation: { providerId: DesktopAgentProviderId; roomIdentifier: string; id: string } | null = null;
  let agentCreated = false;

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
    if (!room.value || roomOrganizationId !== organizationId) {
      try {
        const created = await desktopIpc.room.createInviteRoom({ organizationId });
        room.value = { roomIdentifier: created.roomIdentifier, snapshot: created.snapshot };
        roomOrganizationId = organizationId;
        roomNamed = false;
        creation = null;
        agentCreated = false;
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
        room.value = { ...current, snapshot: { ...current.snapshot, room: info } };
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
      }
    })();
    return running;
  }

  /** Starts over: the next run makes a new room. Does nothing while a run is going. */
  function reset(): void {
    if (running) return;
    state.value = "idle";
    task.value = null;
    error.value = null;
    room.value = null;
    agent.value = null;
    roomOrganizationId = undefined;
    roomNamed = false;
    creation = null;
    agentCreated = false;
  }

  return { state, task, error, room, agent, prepare, run, reset };
}

export type OnboardingFirstRoom = ReturnType<typeof useOnboardingFirstRoom>;
