import type {
  DesktopAgentProviderId,
  DesktopManagedAgentSession,
  DesktopManagedAgentStartInput,
  DesktopManagedAgentStartResult,
  DesktopRoomStreamEvent,
} from "../../ipc-types.js";

export interface DesktopManagedAgentRuntime {
  providerId: DesktopAgentProviderId;
  listSessions(roomIdentifier?: string | null): DesktopManagedAgentSession[];
  start(input: DesktopManagedAgentStartInput): Promise<DesktopManagedAgentStartResult>;
  dispatchRoomStreamEvent(event: DesktopRoomStreamEvent): void;
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

  dispatchRoomStreamEvent(event: DesktopRoomStreamEvent): void {
    for (const runtime of this.list()) {
      runtime.dispatchRoomStreamEvent(event);
    }
  }
}
