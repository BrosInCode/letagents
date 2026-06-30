import {
  getCurrentCodexLiveSession,
  type CodexLiveSessionState,
} from "./local-state.js";
import {
  inspectLocalCodexSession,
  startLocalCodexSession,
  stopLocalCodexSession,
  toPublicCodexLiveSession,
} from "./codex-session.js";
import type { JoinedVia } from "./room-id.js";

export interface StartManagedAgentSessionInput {
  room_id: string;
  room_identifier: string;
  room_code?: string | null;
  room_display_name?: string | null;
  joined_via: JoinedVia;
  cwd?: string;
  stop_phrase?: string;
  max_minutes?: number;
}

export interface StopManagedAgentSessionOptions {
  session_id?: string | null;
  room_id?: string | null;
  shutdown_server?: boolean;
}

export interface StartManagedAgentSessionResult {
  session: unknown;
  reused: boolean;
}

export interface ManagedAgentSessionStatus {
  session: unknown;
  server_reachable: boolean;
  thread_status: unknown;
  turn_status: unknown;
  recent_items: Array<Record<string, unknown>>;
}

export interface ManagedAgentProviderResponseKeys {
  localSession: string;
  localSessionStarted: string;
  localSessionReused: string;
}

export interface ManagedAgentProvider {
  id: string;
  displayName: string;
  responseKeys: ManagedAgentProviderResponseKeys;
  getCurrentLiveSessionPayload(roomId?: string): Record<string, unknown> | null;
  startLocalSession(input: StartManagedAgentSessionInput): Promise<StartManagedAgentSessionResult>;
  inspectLocalSession(
    sessionId?: string | null,
    roomId?: string | null
  ): Promise<ManagedAgentSessionStatus | null>;
  stopLocalSession(options?: StopManagedAgentSessionOptions): Promise<unknown | null>;
  toPublicLiveSession(session: unknown): Record<string, unknown>;
}

interface RegisterManagedAgentProviderOptions {
  replace?: boolean;
  setDefault?: boolean;
}

const providers = new Map<string, ManagedAgentProvider>();
let defaultProviderId = "codex";

function createCodexManagedAgentProvider(): ManagedAgentProvider {
  return {
    id: "codex",
    displayName: "Codex",
    responseKeys: {
      localSession: "local_codex_session",
      localSessionStarted: "local_codex_session_started",
      localSessionReused: "local_codex_session_reused",
    },
    getCurrentLiveSessionPayload(roomId) {
      const session = getCurrentCodexLiveSession(roomId);
      return session ? toPublicCodexLiveSession(session) : null;
    },
    startLocalSession: startLocalCodexSession,
    inspectLocalSession: inspectLocalCodexSession,
    stopLocalSession: stopLocalCodexSession,
    toPublicLiveSession(session) {
      return toPublicCodexLiveSession(session as CodexLiveSessionState);
    },
  };
}

function installBuiltinManagedAgentProviders(): void {
  providers.clear();
  const codexProvider = createCodexManagedAgentProvider();
  providers.set(codexProvider.id, codexProvider);
  defaultProviderId = codexProvider.id;
}

installBuiltinManagedAgentProviders();

export function registerManagedAgentProvider(
  provider: ManagedAgentProvider,
  options: RegisterManagedAgentProviderOptions = {}
): void {
  const id = provider.id.trim();
  if (!id) {
    throw new Error("Managed agent provider id is required.");
  }
  if (providers.has(id) && !options.replace) {
    throw new Error(`Managed agent provider '${id}' is already registered.`);
  }

  providers.set(id, { ...provider, id });
  if (options.setDefault) {
    defaultProviderId = id;
  }
}

export function getManagedAgentProvider(id: string): ManagedAgentProvider {
  const provider = providers.get(id);
  if (!provider) {
    throw new Error(`Managed agent provider '${id}' is not registered.`);
  }
  return provider;
}

export function getDefaultManagedAgentProvider(): ManagedAgentProvider {
  return getManagedAgentProvider(defaultProviderId);
}

export function toManagedAgentStartResponse(
  provider: ManagedAgentProvider,
  result: StartManagedAgentSessionResult
): Record<string, unknown> {
  return {
    [provider.responseKeys.localSession]: provider.toPublicLiveSession(result.session),
    [provider.responseKeys.localSessionStarted]: !result.reused,
    [provider.responseKeys.localSessionReused]: result.reused,
  };
}

export function resetManagedAgentProvidersForTest(): void {
  installBuiltinManagedAgentProviders();
}
