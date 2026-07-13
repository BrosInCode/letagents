import type {
  DesktopManagedAgentInspectResult,
  DesktopManagedAgentInteractionDecisionInput,
  DesktopManagedAgentInteractionDecisionResult,
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
  dispatchRoomStreamEvent(event: DesktopRoomStreamEvent): void;
  resolvePermissionRequest?(
    input: DesktopManagedAgentPermissionDecisionInput,
  ): Promise<DesktopManagedAgentPermissionDecisionResult>;
  resolveInteractionRequest?(
    input: DesktopManagedAgentInteractionDecisionInput,
  ): Promise<DesktopManagedAgentInteractionDecisionResult>;
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
    return this.list().flatMap((runtime) => runtime.listSessions(roomIdentifier));
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

  async resolveInteractionRequest(
    input: DesktopManagedAgentInteractionDecisionInput,
  ): Promise<DesktopManagedAgentInteractionDecisionResult> {
    const requestId = typeof input?.requestId === "string" ? input.requestId : "";
    if (input?.action !== "submit" && input?.action !== "decline" && input?.action !== "cancel") {
      return { requestId, accepted: false, message: "Interaction action must be submit, decline, or cancel.", session: null };
    }
    for (const runtime of this.list()) {
      if (!runtime.resolveInteractionRequest) continue;
      const result = await runtime.resolveInteractionRequest(input);
      if (result.accepted || result.session) return result;
    }
    return { requestId, accepted: false, message: "Interaction request is no longer pending.", session: null };
  }

  dispatchRoomStreamEvent(event: DesktopRoomStreamEvent): void {
    for (const runtime of this.list()) {
      try {
        runtime.dispatchRoomStreamEvent(event);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `Desktop managed runtime '${runtime.providerId}' failed to receive a room event: ${detail}`,
        );
      }
    }
  }
}
