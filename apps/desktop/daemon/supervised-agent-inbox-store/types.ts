import type { RetainedExecutionDetail } from "../../shared/execution-protocol.js";
import type { PreparedRoomContext, MessageIntervention } from "../../shared/message-outcome.js";
import type { FollowUpKind } from "../task-continuity.js";

export type SupervisedInboxState = "pending" | "dispatching" | "awaiting_result" | "result_recovery" | "publishing" | "retryable" | "blocked" | "acknowledged" | "acknowledged_no_reply" | "acknowledged_failed" | "cancelled_by_room_move" | "cancelled_by_user";
export type SupervisedInboxReceiptState = SupervisedInboxState | "queued_behind_blocked";
export type SupervisedRetryDomain = "pre_dispatch" | "result_recovery" | "publication";
export type InboxActivation = Record<string, unknown>;
export type IngressMessage = { source_message_id: string; source_message: unknown; activation: InboxActivation };
export type ObservedIngressMessage = IngressMessage & { activation_decision: string };
export type PollIngestionInput = {
  agent_id: string;
  room_id: string;
  last_observed_message_id: string | null;
  expected_cursor?: string | null;
  messages: readonly IngressMessage[];
  observed_messages?: readonly ObservedIngressMessage[];
};
export type SuccessfulPollIngestionInput = PollIngestionInput & {
  execution_generation_id: string;
  /** Optional observation after COMMIT, never part of ingress authority. */
  onInserted?: (sourceMessageIds: readonly string[]) => void;
};
export type IngressHealthUpdate = {
  agent_id: string;
  room_id: string;
  execution_generation_id: string;
  state: "starting" | "observing" | "backoff" | "blocked" | "stopped";
  detail?: string | null;
};
export type SupervisedInboxItem = {
  inbox_item_id: string; agent_id: string; room_id: string; source_message_id: string;
  source_message: unknown; activation: InboxActivation; fifo_sequence: number; state: SupervisedInboxState;
  attempt_count: number; action_id: string; reply_client_message_id: string; provider_turn_id: string | null;
  outcome: string | null; last_error: string | null; failure_code: "provider_continuation_missing" | null; blocked_by_inbox_item_id: string | null;
  next_attempt_at_ms: number | null; terminal_reason: "upgrade_authority_unavailable" | null;
  created_at: string; updated_at: string; acknowledged_at: string | null;
};
export type InboxHeadSnapshot = Pick<SupervisedInboxItem, "inbox_item_id" | "state" | "provider_turn_id" | "outcome">;

export type SupervisedProviderTurnBinding = {
  inbox_item_id: string;
  agent_id: string;
  room_id: string;
  work_attempt_id: string;
  origin_execution_generation_id: string;
  provider_continuation_id: string;
  provider_turn_id: string;
};
export type SupervisedInboxReceipt = SupervisedInboxItem & { receipt_state: SupervisedInboxReceiptState };
export type SupervisedInboxEvent = {
  event_sequence: number;
  phase: "received" | "queued" | "turn_started" | "turn_finished" | "result_unreadable" | "publish_started" | "published" | "no_reply" | "retry_scheduled" | "blocked" | "room_move_cancelled" | "conversation_restoring" | "conversation_restored" | "user_cancelled";
  observed_at: string;
  detail: string | null;
};
export type SupervisedInboxReceiptWithTimeline = SupervisedInboxReceipt & {
  timeline: SupervisedInboxEvent[];
  canonical_message_id: string | null;
};
export type SupervisedInboxReceiptProjection = Omit<SupervisedInboxReceiptWithTimeline, "source_message" | "activation"> & {
  /** What a follow-up that waits for its time is for. Absent on any other receipt, and on a follow-up that an earlier daemon made. */
  follow_up_kind?: FollowUpKind;
  /**
   * Set on a follow-up that ended because of an uncertain result: whether an action of the turn that failed is still
   * uncertain in the daemon's record. Absent on any other receipt.
   */
  follow_up_uncertain?: boolean;
  /**
   * Set on a follow-up that ended with nothing started and whose note asks its owner to send a message: whether a turn started for a
   * message of a person after it. Absent on any other receipt.
   */
  follow_up_person_turn?: boolean;
};
export type SupervisedInboxItemMetadata = Omit<SupervisedInboxItem, "source_message" | "activation">;

export type SupervisedEffectRecord = {
  effect_id: string; agent_id: string; room_id: string; execution_generation_id: string; provider_turn_id: string;
  mcp_request_id: string; tool_name: string; request: unknown; mutation: boolean;
  state: "prepared" | "executing" | "uncertain" | "completed" | "failed";
  result: unknown | null; error: string | null; created_at: string; updated_at: string;
};
export type StructuredRoomTurnCompletion =
  | { outcome: "reply"; text: string }
  | { outcome: "no_reply"; text: null };

export type AgentInspectorDetail = {
  prepared_context?: PreparedRoomContext | null;
  latest_intervention?: MessageIntervention | null;
  recorded_execution?: RetainedExecutionDetail;
  runtime_control: {
    runtime_generation_id?: string;
    control_state: "connecting" | "responsive" | "degraded" | "lost" | "unprobeable";
    runtime_state: "starting" | "ready" | "stopping" | "exited";
    observed_at: string | null;
    execution_generation_id: string;
    daemon_generation_id: string;
  } | null;
  availability: "available" | "pruned" | "not_loaded";
  entry_id: string; room_id: string; requested_source_message_id: string | null; inbox_item_id: string | null;
  source_message: { id: string; room_id: string; sender: string | null; text: string | null; created_at: string | null; reply_to: string | null; thread_root_id: string | null; activation: InboxActivation | null } | null;
  receipt: { state: SupervisedInboxState; attempt_count: number; provider_turn_id: string | null; outcome: unknown; last_error: string | null; failure_code: "provider_continuation_missing" | null; blocked_by_inbox_item_id: string | null; next_attempt_at_ms: number | null; terminal_reason: "upgrade_authority_unavailable" | null } | null;
  terminal: { outcome: string; normalized_text: string | null; evidence_source: string; observed_at: string } | null;
  publication: { client_message_id: string; canonical_message_id: string | null; room_id: string | null } | null;
  continuation_repair: ProviderContinuationRepair | null;
  timeline: SupervisedInboxEvent[];
  items: Array<{ source_message_id: string; inbox_item_id: string; state: SupervisedInboxState; attempt_count: number; updated_at: string; sender: string | null; text_preview: string | null; created_at: string | null; outcome: unknown; provider_turn_id: string | null; last_error: string | null; failure_code: "provider_continuation_missing" | null; terminal_reason: "upgrade_authority_unavailable" | null; canonical_message_id: string | null }>;
  uncertain_effects: Array<{ effect_id: string; tool_name: string; mcp_request_id: string; error: string; created_at: string; updated_at: string }>;
  history_boundary: { earliest_retained_observed_message_id: string | null; earliest_retained_inbox_message_id: string | null; earliest_retained_receipt_sequence: number | null; pruned_before_message_id: string | null; pruned_at: string | null } | null;
};
export type Row = Record<string, unknown>;

export type ProviderContinuationRepair = {
  repair_id: string;
  agent_id: string;
  room_id: string;
  inbox_item_id: string;
  daemon_generation: number;
  execution_generation_id: string;
  work_attempt_id: string;
  expected_pid: number;
  expected_process_identity: string;
  missing_continuation: string;
  replacement_continuation: string | null;
  phase: "probing" | "replacement_created" | "committed" | "failed";
  attempt_count: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};
