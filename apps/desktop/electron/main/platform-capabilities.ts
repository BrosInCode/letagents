/**
 * What this operating system lets the desktop app do. Supervised agents need
 * the background supervisor daemon, which runs on macOS and Windows.
 *
 * Linux is a development and CI platform, not a shipped one. It keeps the
 * macOS behaviour: agent IPC is registered as usual, and the daemon itself
 * still starts only with LETAGENTS_ALLOW_NON_DARWIN_DAEMON=1.
 *
 * Tests can force agents off with setDesktopPlatformCapabilitiesForTest. Every
 * gate that reads these answers then gives an explicit "unsupported on this
 * platform" result.
 */

export interface DesktopPlatformCapabilities {
  platform: NodeJS.Platform;
  /** Agent features are offered: the IPC is live and the renderer shows them. */
  supervisedAgentsSupported: boolean;
  /** This process may start or connect to the supervisor daemon. */
  supervisorDaemonAllowed: boolean;
}

export interface PlatformCapabilityOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

/** Returned by agent IPC calls instead of throwing when agents are unsupported. */
export interface DesktopUnsupportedPlatformResult {
  ok: false;
  code: "unsupported_platform";
  capability: "supervised_agents";
  platform: NodeJS.Platform;
  message: string;
}

let capabilityOverride: Partial<DesktopPlatformCapabilities> | null = null;

/** Tests only: force a capability answer for code that does not take options. */
export function setDesktopPlatformCapabilitiesForTest(override: Partial<DesktopPlatformCapabilities> | null): void {
  capabilityOverride = override;
}

export function desktopPlatformCapabilities(options: PlatformCapabilityOptions = {}): DesktopPlatformCapabilities {
  const override = options.platform === undefined ? capabilityOverride : null;
  const platform = options.platform ?? override?.platform ?? process.platform;
  const env = options.env ?? process.env;
  // LETAGENTS_ALLOW_NON_DARWIN_DAEMON lets Linux CI drive the daemon client.
  const daemonOverride = env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON === "1";
  const supervisorDaemonAllowed = override?.supervisorDaemonAllowed
    ?? override?.supervisedAgentsSupported
    ?? (platform === "darwin" || platform === "win32" || daemonOverride);
  return {
    platform,
    supervisedAgentsSupported: override?.supervisedAgentsSupported ?? true,
    supervisorDaemonAllowed,
  };
}

export function supervisedAgentsSupported(options: PlatformCapabilityOptions = {}): boolean {
  return desktopPlatformCapabilities(options).supervisedAgentsSupported;
}

export function supervisorDaemonAllowed(options: PlatformCapabilityOptions = {}): boolean {
  return desktopPlatformCapabilities(options).supervisorDaemonAllowed;
}

function platformName(platform: NodeJS.Platform): string {
  if (platform === "win32") return "Windows";
  if (platform === "linux") return "Linux";
  return platform;
}

export function supervisedAgentsUnsupportedMessage(platform: NodeJS.Platform = desktopPlatformCapabilities().platform): string {
  return `Agents that LetAgents runs on this computer are not available on ${platformName(platform)} yet. Chat, rooms and the board work as usual.`;
}

export class SupervisedAgentsUnsupportedError extends Error {
  readonly code = "unsupported_platform";
  constructor(readonly platform: NodeJS.Platform = desktopPlatformCapabilities().platform, message = supervisedAgentsUnsupportedMessage(platform)) {
    super(message);
    this.name = "SupervisedAgentsUnsupportedError";
  }
}

export function supervisedAgentsUnsupportedResult(
  platform: NodeJS.Platform = desktopPlatformCapabilities().platform,
): DesktopUnsupportedPlatformResult {
  return {
    ok: false,
    code: "unsupported_platform",
    capability: "supervised_agents",
    platform,
    message: supervisedAgentsUnsupportedMessage(platform),
  };
}

export function isDesktopUnsupportedPlatformResult(value: unknown): value is DesktopUnsupportedPlatformResult {
  return Boolean(value) && typeof value === "object"
    && (value as { code?: unknown }).code === "unsupported_platform"
    && (value as { ok?: unknown }).ok === false;
}
