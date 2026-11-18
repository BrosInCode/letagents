/**
 * Reasoning-trace logic shared by the web reasoning modal and the desktop
 * reasoning inspector. Plain TypeScript (no Vue), so node tests in both apps
 * can load it. Each app maps its own session shape (snake_case from the API on
 * the web, camelCase over IPC on the desktop) into these small inputs.
 */

/** The structured fields an agent reports. Both apps already use these names. */
export interface ReasoningSnapshot {
  summary: string;
  goal?: string | null;
  checking?: string | null;
  hypothesis?: string | null;
  blocker?: string | null;
  next_action?: string | null;
  milestone?: string | null;
  status?: string | null;
  confidence?: number | null;
}

/** A session's own copies of the snapshot fields, used when it has no stored payload. */
export interface ReasoningSnapshotSource<S extends ReasoningSnapshot = ReasoningSnapshot> {
  latestPayload?: S | null;
  summary?: string | null;
  goal?: string | null;
  checking?: string | null;
  hypothesis?: string | null;
  blocker?: string | null;
  nextAction?: string | null;
  milestone?: string | null;
  confidence?: number | null;
  status?: string | null;
}

export interface ReasoningTimelineEntry {
  id: string;
  label: string;
  text: string;
  timestamp: string | null;
  current?: boolean;
}

/** The latest snapshot: the stored payload, else one built from the session's own fields. */
export function buildReasoningSnapshot<S extends ReasoningSnapshot>(
  source: ReasoningSnapshotSource<S> | null,
): S | ReasoningSnapshot | null {
  if (!source) return null;
  if (source.latestPayload) return source.latestPayload;
  if (
    source.goal
    || source.checking
    || source.hypothesis
    || source.blocker
    || source.nextAction
    || source.milestone
    || typeof source.confidence === "number"
    || source.status
  ) {
    return {
      summary: source.summary || "",
      goal: source.goal,
      checking: source.checking,
      hypothesis: source.hypothesis,
      blocker: source.blocker,
      next_action: source.nextAction,
      milestone: source.milestone,
      confidence: source.confidence,
      status: source.status,
    };
  }
  return source.summary ? { summary: source.summary } : null;
}

/** "next_action" -> "Next Action"; empty -> "Update". */
export function reasoningLabel(value: string | null | undefined): string {
  const label = String(value || "").trim();
  if (!label) return "Update";
  return label.replace(/[_-]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

/** One timeline entry for a stored reasoning update. */
export function reasoningUpdateEntry(update: {
  id: string;
  status?: string | null;
  milestone?: string | null;
  summary?: string | null;
  payloadSummary?: string | null;
  createdAt?: string | null;
}): ReasoningTimelineEntry {
  return {
    id: update.id,
    label: update.milestone ? "Milestone" : reasoningLabel(update.status),
    text: update.summary || update.payloadSummary || update.milestone || "",
    timestamp: update.createdAt || null,
  };
}

/** The live entry for the current summary, marked `current`. Empty when there is no text. */
export function currentReasoningEntry(
  sessionId: string,
  status: string | null | undefined,
  summary: string,
  timestamp: string | null,
): ReasoningTimelineEntry[] {
  const text = summary.trim();
  if (!text) return [];
  return [{
    id: `${sessionId}-current-live`,
    label: reasoningLabel(status || "working"),
    text,
    timestamp,
    current: true,
  }];
}

/** Timeline entries made from the snapshot fields, for a session with no stored updates. */
export function snapshotTimelineEntries(
  sessionId: string,
  snapshot: ReasoningSnapshot | null,
  fallbackSummary: string | null | undefined,
  timestamp: string | null,
): ReasoningTimelineEntry[] {
  const fields: Array<[string, string, string | null | undefined]> = [
    ["summary", "Summary", snapshot?.summary || fallbackSummary],
    ["goal", "Goal", snapshot?.goal],
    ["checking", "Checking", snapshot?.checking],
    ["hypothesis", "Hypothesis", snapshot?.hypothesis],
    ["blocker", "Blocker", snapshot?.blocker],
    ["next-action", "Next action", snapshot?.next_action],
    ["milestone", "Milestone", snapshot?.milestone],
  ];
  return fields
    .filter(([, , text]) => Boolean(String(text || "").trim()))
    .map(([id, label, text]) => ({ id: `${sessionId}-${id}`, label, text: String(text), timestamp }));
}

/**
 * Put entries in time order (then by id), and join a run of entries that repeat
 * the same label and text into one. Order first: joining is for neighbours in time.
 */
export function orderTimelineEntries<E extends ReasoningTimelineEntry>(entries: readonly E[]): E[] {
  const sorted = [...entries].sort((left, right) =>
    timestampValue(left.timestamp) - timestampValue(right.timestamp)
    || String(left.id).localeCompare(String(right.id)));
  const compacted: E[] = [];
  for (const entry of sorted) {
    const previous = compacted[compacted.length - 1];
    if (
      previous
      && previous.label === entry.label
      && normalizeTimelineText(previous.text) === normalizeTimelineText(entry.text)
    ) {
      compacted[compacted.length - 1] = {
        ...previous,
        id: entry.id,
        timestamp: entry.timestamp || previous.timestamp,
        current: Boolean(previous.current || entry.current),
      };
      continue;
    }
    compacted.push(entry);
  }
  return compacted;
}

export function normalizeTimelineText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export type ReasoningStreamState = "live" | "recent" | "snapshot" | "blocked";

export interface ReasoningStreamInput {
  status?: string | null;
  summary?: string | null;
  checking?: string | null;
  nextAction?: string | null;
  /** ISO timestamp of the session's last update; paired with `now`, enables staleness decay. */
  updatedAt?: string | null;
  /** Current time in ms. When supplied, a stale "live" stream decays to "recent". */
  now?: number | null;
  /** Silence window in ms after which a "live" stream is treated as no longer active. */
  staleAfterMs?: number;
}

export interface ReasoningStreamClassification {
  state: ReasoningStreamState;
  label: string;
  description: string;
  isCodexReasoningSummary: boolean;
  isCodexSnapshot: boolean;
}

// A "live" stream with no update within this window is treated as no longer
// active and decays to the "recent" freshness state. 3 minutes: Codex reasoning
// streams refresh every few seconds, so this stays unambiguous while giving a
// legitimately slow turn (a long build or test run) room before it reads stale.
const DEFAULT_STALE_AFTER_MS = 180_000;

/**
 * Classify a reasoning stream's freshness state, pill label, and tooltip.
 *
 * Precedence is deliberate: an explicit `blocked` status is authoritative and
 * outranks the Codex reasoning-summary text heuristic. Codex reasoning streams
 * don't always carry a clean status, so the heuristic infers "live thinking"
 * from the text — but when the provider does report `blocked`, that must win,
 * otherwise a blocked session whose text happens to match renders the green
 * "live" state (and a "Live thinking" pill) around a red Blocker field.
 */
export function classifyReasoningStream(input: ReasoningStreamInput): ReasoningStreamClassification {
  const status = String(input.status || "").trim();
  const normalizedStatus = status.toLowerCase();
  const text = [input.summary, input.checking, input.nextAction].join(" ").toLowerCase();
  const isCodexReasoningSummary =
    text.includes("readable reasoning") || text.includes("reasoning summary");
  const isCodexSnapshot = !isCodexReasoningSummary
    && (text.includes("codex_app_server")
      || text.includes("app-server snapshot")
      || text.includes("snapshot-derived"));

  let state: ReasoningStreamState;
  if (normalizedStatus === "blocked") state = "blocked";
  else if (isCodexReasoningSummary) state = "live";
  else if (isCodexSnapshot) state = "snapshot";
  else if (normalizedStatus === "working" || normalizedStatus === "reviewing") state = "live";
  else state = "recent";

  let label: string;
  if (normalizedStatus === "blocked") label = reasoningLabel(status);
  else if (isCodexReasoningSummary) label = "Live thinking";
  else if (isCodexSnapshot) label = "Snapshot";
  else label = status ? reasoningLabel(status) : "Reasoning";

  let description: string;
  if (normalizedStatus === "blocked") description = label;
  else if (isCodexReasoningSummary) description = "Readable Codex reasoning summary stream";
  else if (isCodexSnapshot) description = "Codex app-server snapshot";
  else description = label;

  // Staleness decay: a "live" stream that has gone quiet is no longer active
  // *right now*, so demote it to "recent". This is the backstop for a completed
  // session whose text still trips the heuristic, and for a worker that dies
  // mid-`working` with no terminal update — both would otherwise claim "Live
  // thinking" forever. Only evaluated when a clock is supplied; `blocked` and
  // already-quiet states never decay (state must be "live" to reach here).
  if (state === "live" && typeof input.now === "number") {
    const updatedAtMs = timestampValue(input.updatedAt ?? null);
    const staleAfterMs = input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    if (updatedAtMs > 0 && input.now - updatedAtMs > staleAfterMs) {
      // "Stale", not "Idle": a live-claiming stream that went silent is
      // possibly dead, which must not glance-alias the healthy `idle` status.
      state = "recent";
      label = "Stale";
      description = "No reasoning updates recently";
    }
  }

  return { state, label, description, isCodexReasoningSummary, isCodexSnapshot };
}

function timestampValue(value: string | null | undefined): number {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}
