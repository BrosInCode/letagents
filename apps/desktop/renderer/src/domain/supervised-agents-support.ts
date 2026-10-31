import { computed, ref } from "vue";
import type { DesktopAppInfo } from "../../../electron/ipc-types";
import { isWindowsPlatform } from "./local-path";
import { isMacPlatform } from "./room-switcher-shortcut";

/**
 * Whether this app may run supervised agents on this computer. The main
 * process reports it in app info. Until that arrives it starts supported.
 */
const supported = ref(true);

/** Development only: `localStorage["letagents.dev.supervisedAgentsSupported"] = "false"` previews the gated state. */
const DEV_OVERRIDE_KEY = "letagents.dev.supervisedAgentsSupported";

function devOverride(): boolean | null {
  if (!import.meta.env?.DEV) return null;
  try {
    const value = globalThis.localStorage?.getItem(DEV_OVERRIDE_KEY);
    return value === "true" ? true : value === "false" ? false : null;
  } catch {
    return null;
  }
}

/** App info without the field comes from an older main process, which ran agents everywhere but Windows. */
export function supervisedAgentsSupportedFromAppInfo(
  info: Pick<DesktopAppInfo, "platform" | "supervisedAgentsSupported">,
): boolean {
  return info.supervisedAgentsSupported ?? !isWindowsPlatform(info.platform);
}

export function applySupervisedAgentsSupport(info: Pick<DesktopAppInfo, "platform" | "supervisedAgentsSupported">): void {
  supported.value = devOverride() ?? supervisedAgentsSupportedFromAppInfo(info);
}

/** Reactive and read-only; templates and composables read `.value`. */
export const supervisedAgentsSupported = computed(() => supported.value);

/** Tests and component previews only. */
export function overrideSupervisedAgentsSupported(value: boolean): void {
  supported.value = value;
}

{
  const override = devOverride();
  if (override !== null) supported.value = override;
}

/** The one notice every agent entry point shows where agents cannot run. */
export function supervisedAgentsUnavailableNotice(platform?: string | null): string {
  const resolved = platform ?? (typeof navigator !== "undefined" ? navigator.platform : "");
  const name = isWindowsPlatform(resolved) ? "Windows" : /linux/i.test(resolved) ? "Linux" : "this computer";
  return `Running agents from this app is coming to ${name}. Chat, rooms and the board work now.`;
}

/** "this Mac" on macOS, "this PC" on Windows, "this computer" elsewhere. */
export function thisComputerLabel(platform?: string | null): string {
  if (isMacPlatform(platform ?? undefined)) return "this Mac";
  return isWindowsPlatform(platform) ? "this PC" : "this computer";
}

/** The place the system keeps saved credentials, for user-facing copy. */
export function credentialStoreLabel(platform?: string | null): string {
  return isMacPlatform(platform ?? undefined) ? "macOS Keychain" : "the system credential store";
}

/** The exact words main uses too (CURSOR_WINDOWS_UNSANDBOXED_NOTICE in cursor-permission-profile.ts). */
export const CURSOR_WINDOWS_UNSANDBOXED_NOTICE =
  "On Windows, Cursor runs without an operating-system sandbox. LetAgents still limits it to this room's folder and permissions.";

/** Shown where Cursor is chosen on Windows; null for another provider or platform. */
export function cursorWindowsSandboxNotice(providerId: string | null | undefined, platform?: string | null): string | null {
  return providerId === "cursor" && isWindowsPlatform(platform) ? CURSOR_WINDOWS_UNSANDBOXED_NOTICE : null;
}
