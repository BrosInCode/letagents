export declare const AGENT_CODENAMES: readonly string[];
export declare const AGENT_CODENAME_SPACE: number;
/** Fused two-word codename at `index`, e.g. "RiverValley". Any integer wraps into the pool. */
export declare function agentCodenameAt(index: number): string;
export declare function agentCodenameSeedIndex(seed: string): number;
/** The form in which two display names are the same name to a room. */
export declare function agentDisplayNameKey(displayName: string): string;
/** A codename no listed name already answers to, or null when the pool is held. */
export declare function suggestFreeAgentCodename(
  heldDisplayNames: Iterable<string | null | undefined>,
  seed: string,
): string | null;
/** Whether a name is what was written when no name was chosen. */
export declare function isPlaceholderAgentDisplayName(
  displayName: string | null | undefined,
  provider?: string | null,
): boolean;
