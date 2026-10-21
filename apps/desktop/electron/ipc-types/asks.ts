/** "Ask for an agent" (docs/ASK_FOR_AN_AGENT.md). Field names match the server. */

export type DesktopAgentAskState = "open" | "claimed" | "on_hold" | "active" | "paused" | "ended" | "expired" | "cancelled";

export interface DesktopAgentAskModel { providerId: string; model: string | null; label: string }

export interface DesktopAgentAsk {
  id: string;
  state: DesktopAgentAskState;
  asker: string;
  provider_id: string;
  model: string | null;
  model_label: string;
  amount_percent: number | null;
  expires_at: string;
  note?: string;
  room_display_name?: string | null;
  is_asker?: boolean;
  is_giver?: boolean;
  giver?: string | null;
  given_model_label?: string | null;
  given_amount_percent?: number | null;
  ended_reason?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface DesktopAgentAskLink {
  ask: DesktopAgentAsk;
  /** Why this link can't be used right now, already worded for the giver. */
  unavailable: { code: string; error: string } | null;
}

export interface DesktopCreateAgentAskInput {
  roomId: string;
  providerId: string;
  model: string | null;
  amountPercent?: number | null;
  note?: string | null;
}

export interface DesktopGiveAgentInput {
  token: string;
  providerId: string;
  model: string | null;
  modelLabel: string;
  amountPercent: number;
}

/** One line per outcome; `ok: false` carries a sentence to show as-is. */
export type DesktopAskResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface DesktopAgentAskProposal {
  id: string;
  summary?: string;
  state: "waiting" | "approved" | "declined" | "failed";
  error: string | null;
  pr_url: string | null;
  files?: Array<{ path: string; deleted: boolean; content: string | null }>;
  created_at?: string;
}

export interface DesktopAgentAskWorkspace {
  proposals: DesktopAgentAskProposal[];
  files_seen: Array<{ kind: "file" | "list" | "search"; target: string; blocked: boolean; at: string }>;
}
