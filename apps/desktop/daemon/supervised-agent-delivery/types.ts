import type { RoomGif } from "../../../../shared/room-expressions.mjs";
import type { RoomHistoryTurnSummary } from "../../../../shared/room-history-summary.mjs";
import type { RecordedReplyAttachment } from "../../../../shared/message-attachments.mjs";
import type { ProviderActionConnectionRef, ProviderActionHandle } from "../provider-action-port.js";
import type { ReplyTurnCompactionProof } from "../reply-turn-compaction.js";
import type { SupervisedInboxItem } from "../supervised-agent-inbox-store.js";
import type { ContinuityTask } from "../task-continuity.js";

export type CompactionReplyTurnAuthority = {
  proof: ReplyTurnCompactionProof;
  invocationId: number;
  recoveryContext: string;
  handle: ProviderActionHandle;
  connection: ProviderActionConnectionRef;
  originExecutionGenerationId: string;
};

export type SupervisedIngressAgent = {
  agentId: string;
  roomId: string;
  provider: string;
  charter?: string;
  /** Daemon ingress is legal only after durable ownership commits. */
  deliveryMode?: "mcp_polling" | "daemon_inbox";
  /** Bound worker API origin; never inferred from a persisted credential. */
  apiUrl: string;
  agentSessionId: string;
  bearer: string;
  /** Provider execution is optional: ingress may continue observing and
   * queueing routed work after the native runtime exits. */
  handle: ProviderActionHandle | null;
  workAttemptId: string;
  providerContinuationId: string | null;
  /** Complete durable provider connection snapshot. A bare PID is not
   * authority because it loses process-birth and transport identity. */
  providerConnection: ProviderActionConnectionRef | null;
  /** Exact daemon generation that owns this room worker binding. */
  executionGenerationId: string;
  daemonGeneration: number;
  /**
   * What happens to this lane if its current runtime ends now: restarted by
   * the convergence loop, or left for the owner. Absent when unknown, and the
   * messages then make no promise about it.
   */
  laneOutlook?: () => Promise<"restarts" | "needs_owner" | undefined>;
};

/** The bearer is intentionally memory-only and must never be persisted or logged. */
export type SupervisedDeliveryAuthority = Pick<SupervisedIngressAgent,
  "agentId" | "roomId" | "provider" | "apiUrl" | "agentSessionId" | "bearer" |
  "executionGenerationId" | "daemonGeneration" | "workAttemptId" |
  "providerContinuationId" | "providerConnection" | "handle">;
/**
 * `lane_lease` is the immutable delivery owner. It deliberately excludes a
 * provider's mutable continuation/process snapshot. `settled_provider_state`
 * additionally requires the durable entry, delivery snapshot, and live handle
 * to agree on the complete provider state.
 */
export type SupervisedAuthorityScope = "lane_lease" | "settled_provider_state";
export type SupervisedAuthorityRevalidator = (
  authority: SupervisedDeliveryAuthority,
  scope: SupervisedAuthorityScope,
) => Promise<boolean> | boolean;
/** @deprecated Retained as a constructor compatibility slot; bounded turns never read startup text. */
export type SupervisedTurnConfigurationResolver = (
  authority: SupervisedDeliveryAuthority,
) => Promise<{ charter?: string }>;

export type SupervisedPollResponse = {
  messages?: Array<Record<string, unknown>>;
  /** Durable progress across rows hidden by worker activation authority. */
  last_observed_message_id?: string | null;
  /** REST poll pagination fact. */
  has_more?: boolean;
};

export interface SupervisedDeliveryHttp {
  /** Fresh public awareness only; never an activation, receipt or poll cursor. Null means an older/local server. */
  context?(input: { roomId: string; apiUrl: string; bearer: string; signal: AbortSignal }): Promise<Array<Record<string, unknown>> | null>;
  /** The room's history summary for an agent's first turn. Null when the room or server has none; never throws for that. */
  historySummary?(input: { roomId: string; apiUrl: string; bearer: string; signal: AbortSignal }): Promise<RoomHistoryTurnSummary | null>;
  /** Optional latency hint after durable no-reply settlement. Work publication remains the reply-order recovery path. */
  reportNoReply?(input: {
    roomId: string; apiUrl: string; bearer: string; sourceMessageId: string; signal: AbortSignal;
  }): Promise<void>;
  /** Relinquish only the speaking position for blocked preparation, native compaction or durable silence. */
  yieldReplyTurn?(input: {
    roomId: string; apiUrl: string; bearer: string; sourceMessageId: string; signal: AbortSignal;
  }): Promise<void>;
  /** Existing task GETs, filtered to this exact worker's active work leases. */
  ownedTasks?(input: { roomId: string; apiUrl: string; bearer: string; agentSessionId: string;
    taskIds?: readonly string[]; heldBefore?: string; signal: AbortSignal }): Promise<ContinuityTask[]>;
  /** Production admission owns first-cursor creation before provider reachability. */
  admissionOwnsInitialCursor?: boolean;
  poll(input: { roomId: string; apiUrl: string; bearer: string; afterMessageId: string | null; signal: AbortSignal }): Promise<SupervisedPollResponse>;
  /**
   * Read the room tail before the first ever daemon cursor is installed. This
   * is intentionally a separate REST history read: an uninitialised poll
   * means "from the beginning", which must never become a new agent's inbox.
   */
  latest?(input: { roomId: string; apiUrl: string; bearer: string; signal: AbortSignal }): Promise<{ messages?: Array<Record<string, unknown>> }>;
  /** Idempotent remote membership join used by the durable room-move journal. */
  joinRoom?(input: { roomId: string; apiUrl: string; bearer: string; signal: AbortSignal }): Promise<{ roomId: string }>;
  /**
   * The bytes of one attachment on a room message, at most `maxBytes`. The
   * bearer goes only to the room API; the storage address it redirects to
   * gets no credential and is never returned, logged or shown. A local room
   * reads the stored file in this process instead. Rejects with
   * RoomAttachmentDownloadError, or with the abort reason.
   */
  downloadAttachment?(input: {
    roomId: string; apiUrl: string; bearer: string; messageId: string; attachmentId: string;
    maxBytes: number; signal: AbortSignal;
  }): Promise<Uint8Array>;
  publish(input: {
    roomId: string;
    apiUrl: string;
    bearer: string;
    text: string;
    clientMessageId: string;
    gif?: RoomGif | null;
    attachments?: Array<{ upload_id: string }>;
    replyTo: string | null;
    threadRootId: string | null;
    signal: AbortSignal;
  }): Promise<{ messageId: string; roomId: string }>;
  /** Stage one file for the next publication with the worker's own bearer. */
  stageAttachment?(input: {
    roomId: string;
    apiUrl: string;
    bearer: string;
    fileName: string;
    mimeType: string;
    bytes: Uint8Array;
    signal: AbortSignal;
  }): Promise<{ uploadId: string }>;
  /** Discard a staged upload the reply did not use; a staged upload otherwise stays until it expires. */
  discardAttachment?(input: { roomId: string; apiUrl: string; bearer: string; uploadId: string; signal: AbortSignal }): Promise<void>;
}

/** The daemon-owned copies of reply attachments; see ReplyAttachmentSpool. */
export type SupervisedReplyAttachmentSpool = {
  read(inboxItemId: string, file: RecordedReplyAttachment): Promise<Uint8Array>;
  remove(inboxItemId: string): Promise<void>;
};

export type SupervisedPollWait = (delayMs: number, signal: AbortSignal) => Promise<void>;
export type SupervisedRoomMoveCommitter = (input: {
  agent: SupervisedIngressAgent;
  inboxItemId: string;
}) => Promise<void>;
export type SupervisedContinuationRestorer = (input: {
  agent: SupervisedIngressAgent;
  item: SupervisedInboxItem;
  manual: boolean;
}) => Promise<"restored" | "replaced" | "authority_changed" | "failed">;
export type SupervisedProviderStateCheckpointer = (input: {
  agent: SupervisedIngressAgent;
  inboxItemId: string;
  providerTurnId: string;
  providerContinuationId: string;
  providerConnection: ProviderActionConnectionRef;
}) => Promise<void>;
export type SupervisedPreparedTurnCheckpointer = (input: {
  agent: SupervisedIngressAgent;
  inboxItemId: string;
  providerTurnId: string;
  providerContinuationId: string;
  providerConnection: ProviderActionConnectionRef;
}) => Promise<void>;
export type SupervisedLifecycleSettler = (agent: SupervisedIngressAgent) => Promise<void>;

/**
 * Process-local lease acquired before a native Stop can affect a provider
 * turn. Its opaque id and action id prevent a stale control continuation from
 * resolving a later delivery that happens to reuse the same agent and row.
 */
export type SupervisedDeliveryInterruptReservation = Readonly<{
  reservationId: number;
  invocationId: number;
  actionId: string;
  inboxItemId: string;
  providerTurnId: string | null;
  agent: SupervisedIngressAgent;
}>;

export type ActiveDeliveryInterruptReservation = {
  reservation: SupervisedDeliveryInterruptReservation;
  recoveryContext: string;
  providerTurnId: string | null;
  decision: Promise<"cancelled" | "resume" | "freeze">;
  resolveDecision: (decision: "cancelled" | "resume" | "freeze") => void;
  disposition: "cancelled" | "resume" | "freeze" | null;
};

export type BearerRotationHold = {
  bearer: string;
  until: number;
  maxHoldMs: number;
  holders: number;
  revoked: boolean;
  successorBinding: boolean;
};
