import type { AdapterCapabilities } from "../../adapter-types.js";

/** Provider key. Matches the `DesktopRentalIdeKind` "antigravity". */
export const ANTIGRAVITY_PROVIDER = "antigravity";

export const ANTIGRAVITY_CAPABILITIES: AdapterCapabilities = Object.freeze({
  supportsExact: false,
  supportsLaneRecovery: true,
  supportsTier2Continuity: false,
});

export const DEFAULT_MAX_FILE_BYTES = 1 * 1024 * 1024;
