import type { IpcMain } from "electron";

import {
  desktopPlatformCapabilities,
  supervisedAgentsUnsupportedMessage,
  supervisedAgentsUnsupportedResult,
  type PlatformCapabilityOptions,
} from "../platform-capabilities.js";

export interface SupervisedAgentIpcGateOptions extends PlatformCapabilityOptions {
  /** Reads that answer with an honest empty value instead of the unsupported result. */
  emptyResults?: Readonly<Record<string, (...args: unknown[]) => unknown>>;
  /** Channels in the same registrar that do not need the supervisor. */
  passThrough?: readonly string[];
}

/** Reads the renderer makes on load; empty answers keep those views quiet. */
export const SUPERVISED_AGENT_EMPTY_RESULTS: Readonly<Record<string, (...args: unknown[]) => unknown>> = {
  "desktop:supervisor:list-agents": () => [],
  "desktop:supervisor:list-host-tool-rules": () => [],
  "desktop:supervisor:list-host-approvals": () => ({ available: false, approvals: [], error: null }),
  "desktop:supervisor:get-launch-events": () => [],
  "desktop:supervisor:get-current-room-move": () => null,
  "desktop:supervisor:watch-agent-stream": () => undefined,
  "desktop:supervisor-grant:get": () => null,
  "desktop:supervisor-grant:get-storage-status": () => ({
    available: false,
    detail: supervisedAgentsUnsupportedMessage(),
    canOpenCredentialStorage: false,
  }),
  "desktop:supervisor:get-service-snapshot": () => ({ status: null, state: null, observedAt: new Date().toISOString() }),
  "desktop:maintenance:status": () => ({ held: false, ready: false }),
  "desktop:workers:list-agent-providers": () => [],
  "desktop:workers:list-agent-provider-models": (providerId: unknown) => ({
    providerId,
    status: "unavailable",
    models: [],
    defaultModel: null,
    error: supervisedAgentsUnsupportedMessage(),
  }),
};

/**
 * Register a domain's handlers through this gate. Where supervised agents are
 * supported it returns the real IpcMain unchanged. Elsewhere every gated
 * channel is still registered, so the renderer never sees "No handler
 * registered", but the handler never reaches the supervisor: a read answers
 * empty and anything else answers with a typed unsupported_platform result.
 */
export function gateSupervisedAgentIpc(
  targetIpcMain: IpcMain,
  options: SupervisedAgentIpcGateOptions = {},
): IpcMain {
  const { platform, supervisedAgentsSupported } = desktopPlatformCapabilities(options);
  if (supervisedAgentsSupported) return targetIpcMain;
  const emptyResults = options.emptyResults ?? SUPERVISED_AGENT_EMPTY_RESULTS;
  const passThrough = new Set(options.passThrough ?? []);
  const handle: IpcMain["handle"] = (channel, listener) => {
    if (passThrough.has(channel)) return targetIpcMain.handle(channel, listener);
    const empty = Object.hasOwn(emptyResults, channel) ? emptyResults[channel] : null;
    return targetIpcMain.handle(channel, async (_event, ...args: unknown[]) =>
      empty ? empty(...args) : supervisedAgentsUnsupportedResult(platform));
  };
  return new Proxy(targetIpcMain, {
    get(target, property) {
      if (property === "handle") return handle;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
