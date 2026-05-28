import type { AdapterCapabilities } from "../../adapter-types.js";

/** Provider key matching `DesktopRentalIdeKind`. */
export const CODEX_PROVIDER = "codex";

export const CODEX_CAPABILITIES: AdapterCapabilities = Object.freeze({
  supportsExact: true,
  supportsLaneRecovery: false,
  supportsTier2Continuity: true,
});

export const DEFAULT_MAX_FILE_BYTES = 32 * 1024 * 1024;
export const DEFAULT_MAX_DISCOVERED_FILES = 25;
export const DEFAULT_MAX_DISCOVERY_DEPTH = 5;
