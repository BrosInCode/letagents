/**
 * Presence chips: short-lived "connected" / "disconnected" chips for agents in
 * the open room. Shared by the web and desktop composers. Plain TypeScript (no
 * Vue import), so node tests in both apps load it with their own Vue copy.
 */

/** How long a connect/disconnect chip stays on screen. */
export const PRESENCE_CHIP_VISIBLE_MS = 4_000;
/** Chips shown at once; older ones leave early when more arrive. */
export const PRESENCE_CHIP_LIMIT = 3;
/**
 * After a room opens, presence can arrive in more than one piece (a cached
 * snapshot, then the fresh one). Changes in this window refine the starting
 * roster rather than announce anyone.
 */
export const PRESENCE_CHIP_SETTLE_MS = 8_000;
/**
 * An agent must stay absent this long before it counts as disconnected. One
 * failed refresh, or a busy agent whose channel looks quiet for a moment,
 * is not a disconnect; returning in time cancels it without any chip.
 */
export const PRESENCE_DISCONNECT_CONFIRM_MS = 20_000;

export interface PresenceChipAgent {
  key: string;
  displayName: string;
  ideLabel: string | null;
  agentKey: string | null;
}

export interface PresenceChip extends PresenceChipAgent {
  id: string;
  kind: "connected" | "disconnected";
}

/** The presence fields chips need. Each app maps its own presence shape into this. */
export interface PresenceChipSource {
  sessionKind: string | null | undefined;
  sourceFlags: readonly string[];
  freshness: string | null | undefined;
  displayName?: string | null;
  actorLabel: string;
  ideLabel?: string | null;
  agentKey?: string | null;
}

/** Reachable now: a worker session that takes deliveries and is active. */
function isReachable(presence: PresenceChipSource): boolean {
  return presence.sessionKind === "worker"
    && presence.sourceFlags.includes("delivery")
    && presence.freshness === "active";
}

/**
 * The agents a person would call connected, keyed by the name the room knows
 * them by rather than a session or agent key: a reconnect mints a new session,
 * and the agent key is missing from some presence sources, and neither must
 * read as one agent leaving and another arriving.
 */
export function reachableAgents(presence: readonly PresenceChipSource[]): Map<string, PresenceChipAgent> {
  const agents = new Map<string, PresenceChipAgent>();
  for (const entry of presence) {
    if (!isReachable(entry)) continue;
    const displayName = entry.displayName?.trim() || entry.actorLabel.split(" | ")[0]?.trim() || entry.actorLabel;
    const key = displayName.toLowerCase();
    if (!key || agents.has(key)) continue;
    // "Agent" is the generic fallback label, not a provider worth showing.
    const ideLabel = entry.ideLabel && entry.ideLabel !== "Agent" ? entry.ideLabel : null;
    agents.set(key, { key, displayName, ideLabel, agentKey: entry.agentKey ?? null });
  }
  return agents;
}

export interface PresenceTracker {
  /** Agents currently counted as connected, including ones briefly missing. */
  known: Map<string, PresenceChipAgent>;
  /** When each missing agent was first seen missing. */
  missingSince: Map<string, number>;
}

export function createPresenceTracker(initial: ReadonlyMap<string, PresenceChipAgent>): PresenceTracker {
  return { known: new Map(initial), missingSince: new Map() };
}

/**
 * Fold the next presence snapshot into the tracker and report what changed.
 * A new agent is a connect at once. A missing agent is a disconnect only once
 * it has stayed missing for PRESENCE_DISCONNECT_CONFIRM_MS.
 */
export function advancePresenceTracker(
  tracker: PresenceTracker,
  next: ReadonlyMap<string, PresenceChipAgent>,
  now: number,
): Array<{ kind: PresenceChip["kind"]; agent: PresenceChipAgent }> {
  const changes: Array<{ kind: PresenceChip["kind"]; agent: PresenceChipAgent }> = [];
  for (const [key, agent] of next) {
    if (!tracker.known.has(key)) changes.push({ kind: "connected", agent });
    tracker.known.set(key, agent);
    tracker.missingSince.delete(key);
  }
  for (const [key, agent] of tracker.known) {
    if (next.has(key)) continue;
    const since = tracker.missingSince.get(key);
    if (since === undefined) {
      tracker.missingSince.set(key, now);
    } else if (now - since >= PRESENCE_DISCONNECT_CONFIRM_MS) {
      tracker.known.delete(key);
      tracker.missingSince.delete(key);
      changes.push({ kind: "disconnected", agent });
    }
  }
  return changes;
}

/**
 * Add new chips to the visible list. An agent has at most one chip, so a
 * quick drop-and-return shows the latest state instead of stacking two.
 */
export function mergePresenceChips(
  visible: readonly PresenceChip[],
  added: readonly PresenceChip[],
): PresenceChip[] {
  const addedKeys = new Set(added.map((chip) => chip.key));
  return [...visible.filter((chip) => !addedKeys.has(chip.key)), ...added].slice(-PRESENCE_CHIP_LIMIT);
}

export interface PresenceChipInput {
  /** The open room (or thread scope); null while none is open. */
  scope: string | null | undefined;
  /** False until the room's presence has actually loaded. */
  ready: boolean;
  presence: readonly PresenceChipSource[];
}

/**
 * The chip state machine behind each app's composable. The roster a room opens
 * with is the baseline: nobody is announced for already being there, and
 * switching rooms starts over.
 */
export function createPresenceChipController(options: {
  getChips: () => readonly PresenceChip[];
  setChips: (chips: PresenceChip[]) => void;
  /** Every change, before the visible list drops any. */
  onChanges?: (changes: PresenceChip[]) => void;
}): { update: (input: PresenceChipInput) => void; dispose: () => void } {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let tracker: PresenceTracker | null = null;
  let baselineScope: string | null = null;
  let settledAt = 0;
  let sequence = 0;
  let lastNext: Map<string, PresenceChipAgent> = new Map();
  let confirmTimer: ReturnType<typeof setTimeout> | null = null;

  function clearChips(): void {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    if (confirmTimer) clearTimeout(confirmTimer);
    confirmTimer = null;
    options.setChips([]);
  }

  function dismiss(id: string): void {
    timers.delete(id);
    options.setChips(options.getChips().filter((chip) => chip.id !== id));
  }

  /**
   * Apply the latest snapshot. A disconnect is confirmed by time, not by the
   * next refresh arriving, so a pending one re-runs this on a timer.
   */
  function advance(now: number): void {
    if (!tracker) return;
    const changes = advancePresenceTracker(tracker, lastNext, now);
    if (tracker.missingSince.size === 0) {
      if (confirmTimer) clearTimeout(confirmTimer);
      confirmTimer = null;
    } else if (!confirmTimer) {
      confirmTimer = setTimeout(() => {
        confirmTimer = null;
        advance(Date.now());
      }, PRESENCE_DISCONNECT_CONFIRM_MS);
    }
    if (changes.length === 0) return;

    const added = changes.map(({ kind, agent }): PresenceChip => ({
      ...agent,
      kind,
      id: `${agent.key}:${kind}:${sequence += 1}`,
    }));
    options.onChanges?.(added);
    const visible = mergePresenceChips(options.getChips(), added);
    const visibleIds = new Set(visible.map((chip) => chip.id));
    for (const [id, timer] of timers) {
      if (visibleIds.has(id)) continue;
      clearTimeout(timer);
      timers.delete(id);
    }
    options.setChips(visible);
    for (const chip of added) {
      if (!visibleIds.has(chip.id)) continue;
      timers.set(chip.id, setTimeout(() => dismiss(chip.id), PRESENCE_CHIP_VISIBLE_MS));
    }
  }

  function update({ scope, ready, presence }: PresenceChipInput): void {
    if (!scope || !ready) {
      tracker = null;
      baselineScope = null;
      clearChips();
      return;
    }
    const next = reachableAgents(presence);
    const now = Date.now();
    if (!tracker || baselineScope !== scope) {
      clearChips();
      tracker = createPresenceTracker(next);
      baselineScope = scope;
      settledAt = now + PRESENCE_CHIP_SETTLE_MS;
      return;
    }
    if (now < settledAt) {
      tracker = createPresenceTracker(next);
      return;
    }
    lastNext = next;
    advance(now);
  }

  return { update, dispose: clearChips };
}
