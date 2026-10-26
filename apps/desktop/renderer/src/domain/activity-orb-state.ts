/**
 * Which thinking-orbs state a live agent shows. The drawing, and the MIT
 * notice of thinking-orbs, are in components/desktop/content/room-chat/activity-orb.ts.
 *
 * searching: a scan sweeps a dotted globe (reading, looking things up).
 * working: particles on tilted orbits (commands, tools, edits).
 * composing: an undulating band (writing the answer).
 * breathing: a slowly morphing ring (waiting: approval, retry, background work).
 */
export type ActivityOrbState = "searching" | "working" | "composing" | "breathing";

/** One supervisor activity event, as the daemon reports it. */
export interface ActivityOrbEvent {
  kind: string;
  method: string;
}

const PROVIDER_RETRY_METHOD = "letagents/providerretry";
const BACKGROUND_WORK_METHOD = "letagents/backgroundwork";

/**
 * The orb for one native activity event. It reads the event's kind and
 * method, the same fields the live summary is chosen from, never the
 * English summary.
 */
export function orbStateForActivity(event: ActivityOrbEvent): ActivityOrbState {
  const kind = event.kind.trim().toLowerCase();
  const method = event.method.trim().toLowerCase();
  if (method === PROVIDER_RETRY_METHOD || method === BACKGROUND_WORK_METHOD) return "breathing";
  if (kind === "approval" || /(?:autoapprovalreview|guardianwarning)/.test(method)) return "breathing";
  if (kind === "text_delta" || method.includes("agentmessage") || method === "assistant") return "composing";
  if (/(?:websearch|webfetch|search|grep|glob|read|fetch)/.test(method)) return "searching";
  if (method.includes("reasoning") || method.includes("thinking")) return "searching";
  return "working";
}

/** The orb for a room turn with no native activity yet. */
export function orbStateForTurn(state: string): ActivityOrbState {
  if (state === "publishing") return "composing";
  if (state === "retrying") return "breathing";
  return "working";
}

/** The orb for a work row: its own state when the projection knows it, else what the row says it does. */
export function orbStateForWork(work: { activity?: ActivityOrbState; waiting?: true; waitsForBackgroundWork?: boolean; awaitingRoomTurn?: true }): ActivityOrbState {
  if (work.waiting || work.waitsForBackgroundWork || work.awaitingRoomTurn) return "breathing";
  return work.activity ?? "working";
}

