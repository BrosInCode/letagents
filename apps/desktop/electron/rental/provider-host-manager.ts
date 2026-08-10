import { createHash } from "node:crypto";

import type {
  DesktopRentalProviderRuntime,
  DesktopRentalProviderSettings,
  DesktopRentalProviderSettingsInput,
  DesktopRentalRuntimeId,
} from "../ipc-types/rental.js";
import { getOrCreateDesktopHostId } from "../main/agents/state.js";
import { listDesktopAgentProviders } from "../main/agents/provider-registry.js";
import { runDesktopAgentProviderPreflight } from "../main/agents/providers.js";
import { listRentalSafePermissionProfiles } from "../main/agents/rental-permission-profiles.js";
import { supervisorDaemonClient, type SupervisorDaemonClient } from "../main/supervisor-daemon.js";
import type { RentalApiClient } from "./api-client.js";
import { listRentalLaunches } from "./launch-journal.js";
import {
  readRentalProviderSettings,
  updateRentalProviderSettings,
  type StoredRentalProviderSettings,
} from "./provider-settings.js";

const HEARTBEAT_MS = 30_000;
const PREFLIGHT_CACHE_MS = 30_000;
const supported = new Set<DesktopRentalRuntimeId>(["codex", "claude-code", "cursor", "open-model"]);

type PreflightResult = Awaited<ReturnType<typeof runDesktopAgentProviderPreflight>> | null;

export function rentalProviderInstallationId(hostId: string): string {
  return `rental-desktop-${createHash("sha256").update(hostId).digest("hex").slice(0, 40)}`;
}

export class RentalProviderHostManager {
  private timer: ReturnType<typeof setInterval> | null = null;
  private syncOperation: Promise<void> | null = null;
  private readonly preflightCache = new Map<string, { checkedAt: number; result: PreflightResult }>();

  constructor(
    private readonly api: RentalApiClient,
    private readonly daemon: SupervisorDaemonClient = supervisorDaemonClient,
    private readonly hostId: () => string = getOrCreateDesktopHostId,
    private readonly preflight: typeof runDesktopAgentProviderPreflight = runDesktopAgentProviderPreflight,
    private readonly availabilityChanged: (enabled: boolean) => void | Promise<void> = () => undefined,
  ) {}

  start(): void {
    void readRentalProviderSettings().then(async (settings) => {
      this.setHeartbeatEnabled(settings.enabled);
      await this.availabilityChanged(settings.enabled);
      if (settings.enabled) await this.sync(settings);
    }).catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.setHeartbeatEnabled(false);
    await Promise.resolve(this.availabilityChanged(false)).catch(() => undefined);
    const settings = await readRentalProviderSettings();
    if (settings.enabled) await this.publish(settings, false).catch(() => undefined);
  }

  async getSettings(): Promise<DesktopRentalProviderSettings> {
    return this.project(await readRentalProviderSettings());
  }

  async updateSettings(input: DesktopRentalProviderSettingsInput): Promise<DesktopRentalProviderSettings> {
    const settings = await updateRentalProviderSettings(input);
    await this.sync(settings);
    this.setHeartbeatEnabled(settings.enabled);
    await this.availabilityChanged(settings.enabled);
    return this.project(settings);
  }

  private setHeartbeatEnabled(enabled: boolean): void {
    if (!enabled) {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      return;
    }
    if (this.timer) return;
    this.timer = setInterval(() => void this.sync().catch(() => undefined), HEARTBEAT_MS);
    this.timer.unref();
  }

  sync(settings?: StoredRentalProviderSettings): Promise<void> {
    if (this.syncOperation) return this.syncOperation;
    const operation = (async () => this.publish(settings ?? await readRentalProviderSettings()))();
    const tracked = operation.finally(() => {
      if (this.syncOperation === tracked) this.syncOperation = null;
    });
    this.syncOperation = tracked;
    return tracked;
  }

  private async publish(settings: StoredRentalProviderSettings, enabledOverride?: boolean): Promise<void> {
    const projection = await this.project(settings);
    const status = await this.daemon.connectIfRunning().catch(() => null);
    const activeSessionIds = status
      ? (await listRentalLaunches())
        .filter((launch) => launch.state === "active" || launch.state === "launching")
        .map((launch) => launch.sessionId)
      : [];
    const runtimes = projection.runtimes
      .filter((runtime) => runtime.enabled && runtime.authenticated && runtime.status === "ready")
      .map((runtime) => ({
        kind: runtime.providerId,
        label: runtime.label,
        authenticated: runtime.authenticated,
        permissionProfiles: runtime.permissionProfileIds,
      }));
    const body = {
      installationId: rentalProviderInstallationId(projection.hostId),
      enabled: (enabledOverride ?? settings.enabled) && projection.blockers.length === 0,
      maxConcurrentSessions: settings.maxConcurrentSessions,
      defaultLrtLimit: settings.defaultLrtLimit,
      defaultTimeLimitMinutes: settings.defaultTimeLimitMinutes,
      manualAcceptRequired: true,
      runtimes,
      generation: status?.generation,
      activeSessionIds,
    };
    const heartbeat = await this.api.heartbeatProviderHost(projection.hostId, body);
    if (heartbeat.ok) return;
    if (heartbeat.status !== 404) throw new Error(`Rental host heartbeat failed: ${heartbeat.error}`);
    const registered = await this.api.registerProviderHost({ hostId: projection.hostId, ...body });
    if (!registered.ok) throw new Error(`Rental host registration failed: ${registered.error}`);
  }

  private async project(settings: StoredRentalProviderSettings): Promise<DesktopRentalProviderSettings> {
    const daemonStatus = await this.daemon.connectIfRunning().catch(() => null);
    const providers = listDesktopAgentProviders().filter((provider) => supported.has(provider.id as DesktopRentalRuntimeId));
    const runtimes = await Promise.all(providers.map(async (provider): Promise<DesktopRentalProviderRuntime> => {
      const providerId = provider.id as DesktopRentalRuntimeId;
      const enabled = settings.enabledRuntimes.includes(providerId);
      const check = await this.runtimePreflight(provider.id);
      const authenticated = Boolean(check && !["auth_required", "missing_runtime", "error", "config_required"].includes(check.status));
      const rentalProfiles = listRentalSafePermissionProfiles(provider.id);
      const rentalReady = Boolean(check?.canStart && rentalProfiles.length);
      return {
        providerId,
        label: provider.name,
        enabled,
        authenticated,
        status: rentalReady ? "ready" : "blocked",
        detail: !rentalProfiles.length
          ? "No verified workspace-rooted rental profile is available for this runtime yet."
          : check?.detail || check?.message || (rentalReady ? "Ready in a verified rental sandbox." : "Finish local runtime setup first."),
        permissionProfileIds: rentalProfiles.map((profile) => profile.id),
      };
    }));
    const blockers: string[] = [];
    if (!daemonStatus) blockers.push("Background agent management is offline.");
    if (!runtimes.some((runtime) => runtime.enabled && runtime.status === "ready")) {
      blockers.push("Enable at least one authenticated runtime with a verified rental sandbox.");
    }
    return {
      enabled: settings.enabled,
      maxConcurrentSessions: settings.maxConcurrentSessions,
      defaultTimeLimitMinutes: settings.defaultTimeLimitMinutes,
      defaultLrtLimit: settings.defaultLrtLimit,
      runtimes,
      hostId: this.hostId(),
      daemonState: daemonStatus ? "online" : "offline",
      blockers,
      updatedAt: settings.updatedAt,
    };
  }

  private async runtimePreflight(providerId: string): Promise<PreflightResult> {
    const cached = this.preflightCache.get(providerId);
    if (cached && Date.now() - cached.checkedAt < PREFLIGHT_CACHE_MS) return cached.result;
    const result = await this.preflight(providerId, {
      // Preflight uses this only as an existence signal; it never becomes
      // the rental cwd. Launches remain in their daemon-owned workspace.
      repoRootPath: process.cwd(),
      launchMode: "supervised",
    }).catch(() => null);
    this.preflightCache.set(providerId, { checkedAt: Date.now(), result });
    return result;
  }
}

let activeManager: RentalProviderHostManager | null = null;

export function setActiveRentalProviderHostManager(manager: RentalProviderHostManager): void {
  activeManager = manager;
  manager.start();
}

export async function stopActiveRentalProviderHostManager(): Promise<void> {
  const manager = activeManager;
  activeManager = null;
  await manager?.stop();
}
