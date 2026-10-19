import { RoomLatencyTrace } from "./room-latency-trace.js";
import { normalizeRoomGif, validReplyGifIntent, type RoomGif } from "../../../shared/room-expressions.mjs";
import { validRecordedReplyAttachments, type RecordedReplyAttachment } from "../../../shared/message-attachments.mjs";
import { createHash, randomUUID } from "node:crypto";
import { SUPERVISED_READ_ONLY_TOOLS } from "../../../shared/supervised-read-tools.mjs";
import { PreparedReadStatements } from "./prepared-reads.js";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { ExecutionShadowStore } from "./execution-shadow-store.js";
import { pendingRuntimeRecovery } from "./runtime-recovery-journal.js";
import type { RetainedExecutionDetail } from "../shared/execution-protocol.js";
import type { PreparedRoomContext, MessageIntervention } from "../shared/message-outcome.js";
import { prepareRoomContext } from "./prepared-room-context.js";
import { freezeQueuedPeers, hasFrozenPeerBatch } from "./queued-peer-deliveries.js";

import { DaemonStateSchema, openDaemonStateDatabase, openPreparedDaemonStateDatabase } from "./daemon-state-database.js";
import { assertDeliveryDrainIngressAllowed, assertNoDeliveryDrain, deliveryDrainAllowsAdmission } from "./delivery-drain.js";
import { assertNoPollingActivation } from "./custodial-polling-activation.js";
import { endedFollowUpReason, FOLLOW_UP_ENDED, FOLLOW_UP_REASONS_THAT_ASK_THE_OWNER, followUpOrigin, parseClaudeApiFailure, parseTaskContinuation, type ClaudeApiFailure, type ContinuityTask, type FollowUpKind, type TaskContinuation } from "./task-continuity.js";
import {
  MAX_QUEUED_NOTICES_PER_TURN, peopleFirstOrder, queuedDeliveryKind, queuedNoticeIds, queuedNoticeReason, queuedNoticesFor, roomArrival,
  type QueuedDeliveryKind,
} from "./queued-delivery-order.js";
import {
  cancelInterruptedSupervisedTurn,
  pruneSupervisedAgentHistory,
  readDurableNativeFailure,
  RETAINED_UNCERTAIN_EFFECTS_PER_AGENT,
  RETAINED_TERMINAL_RECEIPTS_PER_AGENT,
  settleSupervisedTerminalItem,
} from "./supervised-agent-history-retention.js";
import type { SupervisedInboxState, SupervisedInboxReceiptState, SupervisedRetryDomain, InboxActivation, IngressMessage, ObservedIngressMessage, PollIngestionInput, SuccessfulPollIngestionInput, IngressHealthUpdate, SupervisedInboxItem, InboxHeadSnapshot, SupervisedProviderTurnBinding, SupervisedInboxReceipt, SupervisedInboxEvent, SupervisedInboxReceiptWithTimeline, SupervisedInboxReceiptProjection, SupervisedInboxItemMetadata, SupervisedEffectRecord, StructuredRoomTurnCompletion, AgentInspectorDetail, Row, ProviderContinuationRepair } from "./supervised-agent-inbox-store/types.js";
export type { SupervisedInboxState, SupervisedInboxReceiptState, SupervisedRetryDomain, InboxActivation, IngressMessage, ObservedIngressMessage, SupervisedInboxItem, SupervisedProviderTurnBinding, SupervisedInboxReceipt, SupervisedInboxEvent, SupervisedInboxReceiptWithTimeline, SupervisedInboxReceiptProjection, SupervisedEffectRecord, StructuredRoomTurnCompletion, AgentInspectorDetail, ProviderContinuationRepair } from "./supervised-agent-inbox-store/types.js";
import { structuredRoomTurnCompletion, structuredRoomTurnCompletionResult } from "./supervised-agent-inbox-store/turn-completion.js";
export { structuredRoomTurnCompletion } from "./supervised-agent-inbox-store/turn-completion.js";
import { sameInboxHead, finalStates, RETAINED_TIMELINE_EVENTS_PER_RECEIPT, transitions, phaseForTransition, isNewerCursor, valueOrCurrent, providerWorkStarted, persistedTerminalOutcome } from "./supervised-agent-inbox-store/inbox-rules.js";
export { sameInboxHead } from "./supervised-agent-inbox-store/inbox-rules.js";
import { run, UNTOUCHED_PENDING_SQL, UNTOUCHED_BLOCKED_FOLLOW_UP_SQL, RECEIPT_METADATA_COLUMNS, RECEIPT_SELECTION_SQL, INBOX_READS } from "./supervised-agent-inbox-store/sql.js";
import { rowToItem, rowToReceiptProjectionMetadata, rowToItemMetadata, rowToProviderTurnBinding, sameProviderTurnBinding, rowToEvent, rowToInspectorItem, rowToContinuationRepair, safeOutcome, safeSource, boundaryToDetail } from "./supervised-agent-inbox-store/row-mapping.js";
import { EffectAuthorityError, MAX_EFFECTS_PER_PROVIDER_TURN, MAX_UNRESOLVED_EFFECTS_PER_AGENT, MAX_EFFECT_REQUEST_BYTES, MAX_EFFECT_REQUEST_BYTES_PER_PROVIDER_TURN, MAX_EFFECT_RESULT_BYTES, MAX_EFFECT_RESULT_BYTES_PER_PROVIDER_TURN, MAX_EFFECT_ERROR_BYTES, serializeEffectJson, effectRequestFingerprint, truncateEffectError, rowToEffect, rowToTombstonedEffect } from "./supervised-agent-inbox-store/effect-values.js";
import { InboxStoreBase } from "./supervised-agent-inbox-store/store-base.js";
import { InboxIngressStore } from "./supervised-agent-inbox-store/ingress.js";
import { InboxTaskContinuationStore } from "./supervised-agent-inbox-store/task-continuations.js";
import { InboxQueryStore } from "./supervised-agent-inbox-store/queries.js";
import { InboxEffectStore } from "./supervised-agent-inbox-store/effects.js";
import { InboxRoomMoveStore } from "./supervised-agent-inbox-store/room-moves.js";
import { InboxDeliveryStore } from "./supervised-agent-inbox-store/delivery.js";
import { SupervisedAgentInboxStore } from "./supervised-agent-inbox-store/store.js";
export { SupervisedAgentInboxStore } from "./supervised-agent-inbox-store/store.js";

