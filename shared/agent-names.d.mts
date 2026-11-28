export declare function normalizeRoutingSender(value: unknown): string;
export declare function normalizeRoutingHandle(value: unknown): string;
export declare const AGENT_CODENAMES: readonly string[];
export declare const AGENT_CODENAME_SPACE: number;
/** Fused two-word codename at `index`, e.g. "RiverValley". Any integer wraps into the pool. */
export declare function agentCodenameAt(index: number): string;
/** The form in which two display names are the same name to a room. */
export declare function agentDisplayNameKey(displayName: string): string;
/** A codename no listed name already answers to, scanning from `start`, or null when the pool is held. */
export declare function suggestFreeAgentCodenameFrom(
  heldDisplayNames: Iterable<string | null | undefined>,
  start: number,
): string | null;
/** Short names the Add agent dialog offers first, in order, before a codename. */
export declare const FRIENDLY_AGENT_NAMES: readonly string[];
