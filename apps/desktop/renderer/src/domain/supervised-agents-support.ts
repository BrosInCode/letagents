import { computed, ref } from "vue";
import type { DesktopAppInfo } from "../../../electron/ipc-types";
import { isWindowsPlatform } from "./local-path";
import { isMacPlatform } from "./room-switcher-shortcut";

/**
 * Whether this app may run supervised agents on this computer. The main
 * process reports it in app info; until that arrives a renderer page guesses
 * from the browser platform, so no daemon read starts on a platform without
 * agents. Outside a page (unit tests under Node) it starts supported.
 */
const supported = ref(typeof document === "undefined" || isMacPlatform());

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

/** App info without the field (an older main process) means agents run only on macOS. */
export function supervisedAgentsSupportedFromAppInfo(
  info: Pick<DesktopAppInfo, "platform" | "supervisedAgentsSupported">,
): boolean {
  return info.supervisedAgentsSupported ?? info.platform === "darwin";
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
