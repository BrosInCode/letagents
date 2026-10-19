/**
 * "Ask for an agent" lifecycle. Pure rules, no database: the store applies
 * them with status-guarded updates so the first writer wins every race.
 * Product spec: docs/ASK_FOR_AN_AGENT.md.
 */

export const ASK_LINK_TTL_MS = 24 * 60 * 60_000;
export const ASK_CLAIM_TTL_MS = 15 * 60_000;
export const ASK_HOLD_TTL_MS = 24 * 60 * 60_000;
export const ASK_PAUSE_TTL_MS = 24 * 60 * 60_000;
/**
 * A worker silent for this long counts as offline. Idle agents long-poll for
 * up to 3 minutes per request, so anything shorter would flap.
 */
export const ASK_OFFLINE_AFTER_MS = 5 * 60_000;
export const ASK_OPEN_LIMIT = 5;
export const ASK_NOTE_MAX = 500;

export type AgentAskState = "open" | "claimed" | "on_hold" | "active" | "paused" | "ended" | "expired" | "cancelled";
export type AgentAskEndReason =
  | "amount_used" | "provider_limit" | "removed" | "room_deleted" | "offline" | "substitute_declined";

export const ASK_LIVE_STATES: readonly AgentAskState[] = ["open", "claimed", "on_hold", "active", "paused"];
export const ASK_AGENT_STATES: readonly AgentAskState[] = ["on_hold", "active", "paused"];

const TRANSITIONS: Record<AgentAskState, readonly AgentAskState[]> = {
  open: ["claimed", "expired", "cancelled"],
  claimed: ["open", "claimed", "on_hold", "active", "expired", "cancelled"],
  on_hold: ["active", "open", "expired", "ended"],
  active: ["paused", "ended"],
  paused: ["active", "ended"],
  ended: [],
  expired: [],
  cancelled: [],
};

export function canTransition(from: AgentAskState, to: AgentAskState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * The newest models a person can ask for. LetAgents keeps this list (D24) so
 * someone without the provider installed still sees it. `model: null` means
 * "that provider's current default", for providers whose ids we don't pin.
 */
export interface AskableModel { providerId: string; model: string | null; label: string }
export const ASKABLE_MODELS: readonly AskableModel[] = Object.freeze([
  { providerId: "claude-code", model: "claude-fable-5-1", label: "Claude Fable 5.1" },
  { providerId: "claude-code", model: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { providerId: "claude-code", model: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { providerId: "claude-code", model: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
  { providerId: "codex", model: null, label: "Codex (latest model)" },
  { providerId: "cursor", model: null, label: "Cursor (latest model)" },
]);

export function findAskableModel(providerId: unknown, model: unknown): AskableModel | null {
  return ASKABLE_MODELS.find(entry => entry.providerId === providerId && entry.model === (model ?? null)) ?? null;
}

/** Exact match is what the asker asked for; anything else waits on hold (D15). */
export function isExactMatch(ask: { provider_id: string; model: string | null },
  given: { providerId: string; model: string | null }): boolean {
  if (ask.provider_id !== given.providerId) return false;
  return ask.model === null || ask.model === given.model;
}

export function parseAmountPercent(value: unknown, { required }: { required: boolean }): number | null | "invalid" {
  if (value === undefined || value === null) return required ? "invalid" : null;
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 100 ? value : "invalid";
}

/** One sentence per outcome, shown to the person it affects (spec rule 4). */
export const ASK_ROOM_TEXT = {
  asked: (asker: string, model: string) => `${asker} asked for a ${model} agent.`,
  joined: (giver: string, model: string) => `Hi, I'm ${model}, added by ${giver}.`,
  joinedWithNote: (giver: string, model: string, note: string) =>
    `Hi, I'm ${model}, added by ${giver}. You asked for help with: ${note}. Say when to start.`,
  substitute: (giver: string, asked: string, given: string, asker: string) =>
    `${giver} couldn't give ${asked} and added ${given} instead. ${asker}, accept or remove it.`,
  offline: (giver: string) => `${giver}'s agent is offline.`,
  back: (giver: string) => `${giver}'s agent is back.`,
  ended: {
    amount_used: (giver: string, amount: number | null) => amount
      ? `${giver}'s agent used the ${amount}% ${giver} gave and has left.` : `${giver}'s agent used what ${giver} gave and has left.`,
    provider_limit: (giver: string) => `${giver}'s agent reached ${giver}'s usage limit and has left.`,
    removed: (giver: string) => `${giver}'s agent was removed.`,
    room_deleted: (giver: string) => `${giver}'s agent has left.`,
    offline: (giver: string) => `${giver}'s agent was offline for a day and has left.`,
    substitute_declined: (giver: string) => `${giver}'s agent was removed.`,
  } satisfies Record<AgentAskEndReason, (giver: string, amount: number | null) => string>,
};
