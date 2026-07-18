import {
  computed,
  inject,
  type ComputedRef,
  type InjectionKey,
  type Ref,
} from "vue";
import type {
  DesktopAgentProviderId,
  DesktopGitRoomInfo,
  DesktopManagedAgentSession,
} from "../../../../../../electron/ipc-types";
import {
  cursorMcpPolicyLabel,
  isVisibleManagedAgentSession,
  managedAgentPermissionProfileLabel,
  managedAgentRepoDetail,
  managedAgentSessionDisplayName,
  managedAgentSessionMatchesRoom,
  managedAgentSessionStatusLabel,
} from "../../../../domain/managed-agents";

export interface ManagedAgentSessionsContext {
  sessions: Readonly<Ref<readonly DesktopManagedAgentSession[]>>;
  refresh: () => Promise<void>;
  upsert: (session: DesktopManagedAgentSession) => void;
}

export interface AddAgentManagedSessionView {
  id: string;
  providerId: DesktopAgentProviderId;
  deliveryMode: DesktopManagedAgentSession["deliveryMode"];
  deliveryLabel: string;
  displayName: string;
  detail: string;
  canStop: boolean;
}

export const managedAgentSessionsKey: InjectionKey<ManagedAgentSessionsContext> =
  Symbol("managed-agent-sessions");

export function useManagedAgentSessionsContext(): ManagedAgentSessionsContext {
  const context = inject(managedAgentSessionsKey, null);
  if (!context) {
    throw new Error("Managed agent session context is unavailable.");
  }
  return context;
}

export function managedAgentSessionViews(
  sessions: readonly DesktopManagedAgentSession[],
  roomIdentifier: string,
  providerId: DesktopAgentProviderId | null,
  roomGitRoom: DesktopGitRoomInfo | null = null,
): AddAgentManagedSessionView[] {
  if (!providerId) return [];
  return sessions
    .filter((session) =>
      session.providerId === providerId
      && managedAgentSessionMatchesRoom(session, roomIdentifier)
      && isVisibleManagedAgentSession(session)
    )
    .map((session) => ({
      id: session.id,
      providerId: session.providerId,
      deliveryMode: session.deliveryMode,
      deliveryLabel: session.deliveryMode === "desktop_events"
        ? "From this desktop app"
        : "From the agent app",
      displayName: managedAgentSessionDisplayName(session),
      detail: [
        managedAgentSessionStatusLabel(session),
        managedAgentPermissionProfileLabel(session),
        session.providerId === "cursor" ? cursorMcpPolicyLabel(session.cursorMcpPolicy) : null,
        session.model || null,
        session.effort ? `${managedAgentEffortLabel(session.effort)} effort` : null,
        managedAgentRepoDetail(session, roomGitRoom),
      ].filter(Boolean).join(" - "),
      canStop: session.canStop,
    }));
}

function managedAgentEffortLabel(effort: string): string {
  if (effort === "low") return "Low";
  if (effort === "medium") return "Medium";
  if (effort === "high") return "High";
  if (effort === "xhigh") return "Extra high";
  if (effort === "max") return "Max";
  return effort;
}

export function useStableManagedAgentSessionViews(
  roomIdentifier: () => string,
  providerId: () => DesktopAgentProviderId | null,
  roomGitRoom: () => DesktopGitRoomInfo | null = () => null,
): ComputedRef<AddAgentManagedSessionView[]> {
  const context = useManagedAgentSessionsContext();
  const select = createManagedAgentSessionViewSelector();
  return computed(() => select(
    context.sessions.value,
    roomIdentifier(),
    providerId(),
    roomGitRoom(),
  ));
}

export function createManagedAgentSessionViewSelector(): typeof managedAgentSessionViews {
  let previousSignature = "";
  let previous: AddAgentManagedSessionView[] = [];
  return (sessions, roomIdentifier, providerId, roomGitRoom = null) => {
    const next = managedAgentSessionViews(
      sessions,
      roomIdentifier,
      providerId,
      roomGitRoom,
    );
    const signature = JSON.stringify(next);
    if (signature === previousSignature) return previous;
    previousSignature = signature;
    previous = next;
    return previous;
  };
}
