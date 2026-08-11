import type {
  DesktopManagedAgentInspectResult,
  DesktopAgentProviderId,
  DesktopManagedAgentPermissionDecisionInput,
  DesktopManagedAgentPermissionDecisionResult,
  DesktopManagedAgentRetryInput,
  DesktopManagedAgentSession,
  DesktopManagedAgentStartInput,
  DesktopManagedAgentStartResult,
  DesktopManagedAgentStopInput,
  DesktopRoomStreamEvent,
} from "../../ipc-types.js";

export interface DesktopManagedAgentRuntime {
  providerId: DesktopAgentProviderId;
  listSessions(roomIdentifier?: string | null): DesktopManagedAgentSession[];
  start(input: DesktopManagedAgentStartInput): Promise<DesktopManagedAgentStartResult>;
  inspect(
    sessionId?: string | null,
    roomIdentifier?: string | null,
  ): Promise<DesktopManagedAgentInspectResult | null>;
  stop(input?: DesktopManagedAgentStopInput): Promise<DesktopManagedAgentSession | null>;
  retry(input: DesktopManagedAgentRetryInput): Promise<DesktopManagedAgentSession | null>;
  dispatchRoomStreamEvent(
    event: DesktopRoomStreamEvent,
    context?: DesktopManagedAgentDispatchContext,
  ): void;
  resolvePermissionRequest?(
    input: DesktopManagedAgentPermissionDecisionInput,
  ): Promise<DesktopManagedAgentPermissionDecisionResult>;
}

export interface DesktopManagedAgentDispatchContext {
  /** Complete cross-provider room population used for global ambiguity checks. */
  roomSessions: DesktopManagedAgentSession[];
  /** False when any provider failed to enumerate its room sessions. */
  populationComplete: boolean;
  failedProviderIds: DesktopAgentProviderId[];
}

export interface DesktopManagedAgentSessionPopulation {
  sessions: DesktopManagedAgentSession[];
  complete: boolean;
  failedProviderIds: DesktopAgentProviderId[];
}

export class DesktopManagedAgentRuntimeRegistry {
  private readonly runtimes = new Map<DesktopAgentProviderId, DesktopManagedAgentRuntime>();

  register(runtime: DesktopManagedAgentRuntime): void {
    if (this.runtimes.has(runtime.providerId)) {
      throw new Error(`Desktop managed runtime already registered for provider '${runtime.providerId}'.`);
    }
    this.runtimes.set(runtime.providerId, runtime);
  }

  get(providerId: DesktopAgentProviderId): DesktopManagedAgentRuntime {
    const runtime = this.runtimes.get(providerId);
    if (!runtime) {
      throw new Error(`No desktop managed runtime registered for provider '${providerId}'.`);
    }
    return runtime;
  }

  list(): DesktopManagedAgentRuntime[] {
    return [...this.runtimes.values()];
  }

  listSessions(roomIdentifier?: string | null): DesktopManagedAgentSession[] {
    return this.listSessionPopulation(roomIdentifier).sessions;
  }

  listSessionPopulation(
    roomIdentifier?: string | null,
  ): DesktopManagedAgentSessionPopulation {
    const sessions: DesktopManagedAgentSession[] = [];
    const failedProviderIds: DesktopAgentProviderId[] = [];
    for (const runtime of this.list()) {
      try {
        sessions.push(...runtime.listSessions(roomIdentifier));
      } catch (error) {
        failedProviderIds.push(runtime.providerId);
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `Desktop managed runtime '${runtime.providerId}' failed to list sessions: ${detail}`,
        );
      }
    }
    return {
      sessions,
      complete: failedProviderIds.length === 0,
      failedProviderIds,
    };
  }

  async start(input: DesktopManagedAgentStartInput): Promise<DesktopManagedAgentStartResult> {
    return this.get(input.providerId).start(input);
  }

  async inspect(
    sessionId?: string | null,
    roomIdentifier?: string | null,
  ): Promise<DesktopManagedAgentInspectResult | null> {
    for (const runtime of this.list()) {
      const result = await runtime.inspect(sessionId, roomIdentifier);
      if (result) {
        return result;
      }
    }
    return null;
  }

  async stop(input: DesktopManagedAgentStopInput = {}): Promise<DesktopManagedAgentSession | null> {
    for (const runtime of this.list()) {
      const result = await runtime.stop(input);
      if (result) {
        return result;
      }
    }
    return null;
  }

  async retry(input: DesktopManagedAgentRetryInput): Promise<DesktopManagedAgentSession | null> {
    for (const runtime of this.list()) {
      const result = await runtime.retry(input);
      if (result) return result;
    }
    return null;
  }

  async resolvePermissionRequest(
    input: DesktopManagedAgentPermissionDecisionInput,
  ): Promise<DesktopManagedAgentPermissionDecisionResult> {
    const requestId = typeof input?.requestId === "string" ? input.requestId : "";
    if (input?.behavior !== "allow" && input?.behavior !== "deny") {
      return {
        requestId,
        accepted: false,
        message: "Permission behavior must be allow or deny.",
        session: null,
      };
    }
    for (const runtime of this.list()) {
      if (!runtime.resolvePermissionRequest) {
        continue;
      }
      const result = await runtime.resolvePermissionRequest(input);
      if (result.accepted || result.session) {
        return result;
      }
    }
    return {
      requestId: input.requestId,
      accepted: false,
      message: "Permission request is no longer pending.",
      session: null,
    };
  }

  dispatchRoomStreamEvent(event: DesktopRoomStreamEvent): void {
    const population = this.listSessionPopulation(event.roomIdentifier);
    const context: DesktopManagedAgentDispatchContext = {
      roomSessions: population.sessions,
      populationComplete: population.complete,
      failedProviderIds: population.failedProviderIds,
    };
    for (const runtime of this.list()) {
      try {
        runtime.dispatchRoomStreamEvent(event, context);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `Desktop managed runtime '${runtime.providerId}' failed to receive a room event: ${detail}`,
        );
      }
    }
  }
}
