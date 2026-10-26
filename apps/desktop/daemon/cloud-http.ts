import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { roomRequest, isLocalRoomApi, LOCAL_ROOM_API_ORIGIN } from "./local-room-runtime.js";
import type { WorkspaceReviewPage } from '../../../shared/workspace-review.mjs';
import { stageCloudMessageAttachment } from "../../../shared/message-attachments.mjs";
import { SupervisedRoomAuthorizationError, type SupervisedDeliveryHttp, type SupervisedPollResponse } from "./supervised-agent-delivery.js";
import type { DaemonToolAgentSession } from "./supervised-tool-runtime.js";
import type { RemoteExecutionDelegationRevision } from "./execution-delegation-journal.js";
import { LOCAL_ROOM_ATTACHMENT_ID, RoomAttachmentDownloadError } from "./room-turn-attachments.js";
import {
  parseExecutionDelegationDecisionIntent,
  type ExecutionDelegationDecisionIntent,
} from "../../../shared/execution-delegation-decision.mjs";
import { isClearedRoomAgentWorkSummary, parseRoomAgentWorkSummary, type RoomAgentWorkSummary } from "../../../shared/room-agent-work.mjs";
import { ROOM_HISTORY_TURN_VIEW_LINES, roomHistoryTurnSummary } from "../../../shared/room-history-summary.mjs";
import type { PeerReceiptResult } from "./queued-peer-deliveries.js";

/** Exact self-receipt reporting for messages explicitly delivered in another turn. */
export async function reportGroupedNoReply(input: {
  roomId: string; apiUrl: string; bearer: string; sourceMessageId: string; signal: AbortSignal;
}): Promise<PeerReceiptResult> {
  if (isLocalRoomApi(input.apiUrl) || !/^msg_[1-9]\d*$/.test(input.sourceMessageId)) {
    throw new Error("Grouped receipt requires a canonical hosted room source.");
  }
  const response = await roomRequest(`${input.apiUrl}/rooms/${supervisedRoomPath(input.roomId)}/messages/${input.sourceMessageId}/agent-receipts/self`, {
    method: "PUT", redirect: "error", headers: { authorization: `Bearer ${input.bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ receipt_state: "no_reply" }), signal: AbortSignal.any([input.signal, AbortSignal.timeout(CLOUD_REQUEST_TIMEOUT_MS)]),
  });
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (response.ok && body?.success === true && body.receipt_state === "no_reply"
    && typeof body.receipt_id === "string" && body.receipt_id.trim()) return "no_reply";
  // A separate tool reply may already have settled this exact receipt. A bare
  // compare-and-set conflict, unavailable or any other HTTP error stays pending.
  if (response.status === 409 && (body?.receipt_state === "replied" || body?.receipt_state === "cancelled")) return body.receipt_state;
  throw new Error(`Grouped receipt was not acknowledged (HTTP ${response.status}).`);
}

const DEFAULT_ROOM_POLL_MAX_MS = 180_000;
// Public deployments commonly terminate idle upstream requests at 60 seconds.
// Keep the daemon's individual observation requests below that boundary; the
// delivery loop immediately opens the next poll, so this does not add latency.
const SUPERVISED_ROOM_POLL_TIMEOUT_MS = 25_000;
const MAX_ROOM_POLL_MAX_MS = 24 * 60 * 60 * 1_000;
const LIVENESS_GRACE_MS = 30_000;
export const NATIVE_LIVENESS_STALE_AFTER_MS = 90_000;
const CLOUD_REQUEST_TIMEOUT_MS = 20_000;
/** A 25 MB attachment upload to object storage needs longer than an API call. */
const ATTACHMENT_UPLOAD_TIMEOUT_MS = 120_000;
const EXECUTION_DELEGATION_INVENTORY_PAGE_SIZE = 100;

export type CloudWorkLease = {
  id: string; room_id: string; task_id: string; agent_session_id: string;
  agent_key: string; agent_instance_id: string; epoch: number;
};
type LeaseReadInput = { apiUrl: string; roomId: string; bearer: string; signal?: AbortSignal };
type LeaseAttestationInput = {
  apiUrl: string; grantId: string; supervisorGrant: string; grantGeneration: number;
  lease: CloudWorkLease; workAttemptId: string; executionGenerationId: string;
  cause: "exited" | "killed" | "stopped" | "crashed" | "protocol_error"; signal?: AbortSignal;
};

export interface SupervisorGrantHttp {
  listWorkLeases?(input: LeaseReadInput): Promise<CloudWorkLease[]>;
  readWorkLease?(input: LeaseReadInput & { taskId: string; leaseId: string }): Promise<CloudWorkLease | null>;
  attestWorkLease?(input: LeaseAttestationInput): Promise<string>;
  rebindWorkLease?(input: LeaseAttestationInput & { attestationId: string; toSessionId: string }): Promise<CloudWorkLease>;
  createWorkerSession(input: {
    apiUrl: string; grantId: string; supervisorGrant: string; grantGeneration: number; roomId: string; agentKey: string; agentInstanceId: string;
    provider: string; displayName: string; model?: string | null; charter?: string | null; signal?: AbortSignal;
  }): Promise<{
    sessionId: string; bearer: string; bearerId: string; expiresAt: string | null;
    /** Exact public identity paired with the worker bearer by the server. */
    agentSession?: DaemonToolAgentSession;
  }>;
  endWorkerSession?(input: {
    apiUrl: string; grantId: string; supervisorGrant: string; grantGeneration: number; sessionId: string;
    /** The agent starts again in the same room; the server keeps the turn it shared there. */
    restarting?: boolean;
  }): Promise<void>;
  renewHostGrant?(input: {
    apiUrl: string; grantId: string; supervisorGrant: string; grantGeneration: number;
    hostId: string; installationId: string; ttlMs: number;
  }): Promise<{ grantId: string; supervisorGrant: string; grantGeneration: number; expiresAt: string }>;
  getExecutionDelegation(input: {
    apiUrl: string; grantId: string; supervisorGrant: string; grantGeneration: number;
    delegationInstanceId: string; signal?: AbortSignal;
  }): Promise<RemoteExecutionDelegationRevision>;
  listExecutionDelegationIds(input: {
    apiUrl: string; grantId: string; supervisorGrant: string; grantGeneration: number;
    roomId: string; agentKey: string; after: string | null; signal?: AbortSignal;
  }): Promise<{ delegationInstanceIds: string[]; nextCursor: string | null }>;
  getExecutionDelegationDecision?(input: {
    apiUrl: string; grantId: string; supervisorGrant: string; grantGeneration: number;
    decisionId: string; signal?: AbortSignal;
  }): Promise<ExecutionDelegationDecisionIntent>;
  listExecutionDelegationDecisionIds?(input: {
    apiUrl: string; grantId: string; supervisorGrant: string; grantGeneration: number;
    roomId: string; agentKey: string; after: string | null; signal?: AbortSignal;
  }): Promise<{ decisionIds: string[]; nextCursor: string | null }>;
}

export class SupervisorGrantRequestError extends Error {
  constructor(readonly status: number, operation: string) {
    super(`${operation} failed with HTTP ${status}.`);
  }
}

/** The room server answered a native-activity publication and refused it. */
export class NativeActivityRejectedError extends Error {
  /** null when the server accepted the request but refused the observation itself. */
  constructor(message: string, readonly status: number | null) {
    super(message);
  }
}

export function supervisedProviderLabel(provider: string): string {
  switch (provider.trim().toLowerCase()) {
    case "codex": return "Codex";
    case "claude":
    case "claude-code": return "Claude Code";
    case "antigravity": return "Antigravity";
    case "cursor": return "Cursor";
    case "open-model":
    case "open_model": return "Open Model";
    default: return provider.trim() || "Agent";
  }
}

function supervisedRoomPath(roomId: string): string {
  return roomId.split("/").map(encodeURIComponent).join("/");
}

export function hostGrantApiOrigin(value: string): string {
  if (isLocalRoomApi(value)) return LOCAL_ROOM_API_ORIGIN;
  const url = new URL(value);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Host grant api_url must be HTTPS or exact loopback HTTP.");
  }
  return url.origin;
}

const ATTACHMENT_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Read at most `maxBytes` of a response body. The declared length is a hint;
 * the counted bytes decide.
 */
async function boundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new RoomAttachmentDownloadError("too_large");
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new RoomAttachmentDownloadError("too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/**
 * An address on this machine or only on its link: loopback, unspecified or
 * link-local (cloud metadata lives there). Private networks are not in it,
 * because self-hosted object storage may live on one.
 */
export function isThisMachineAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "").toLowerCase();
  // An IPv4-mapped address, in either the dotted form or the hex form a URL normalizes it to.
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(bare);
  const v4 = hex ? [parseInt(hex[1]!, 16) >> 8, parseInt(hex[1]!, 16) & 255, parseInt(hex[2]!, 16) >> 8, parseInt(hex[2]!, 16) & 255].join(".")
    : bare.startsWith("::ffff:") && isIP(bare.slice(7)) === 4 ? bare.slice(7) : bare;
  if (isIP(v4) === 4) {
    const [first, second] = v4.split(".").map(Number);
    return first === 127 || first === 0 || (first === 169 && second === 254);
  }
  return isIP(bare) === 6 && (bare === "::1" || bare === "::" || /^fe[89ab]/.test(bare));
}

function namesThisMachine(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return bare === "localhost" || bare.endsWith(".localhost") || isThisMachineAddress(bare);
}

/** A room API in development runs on loopback itself; a link-local one is another device. */
function isLoopbackApi(apiUrl: string): boolean {
  const bare = new URL(apiUrl).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return bare === "localhost" || bare.endsWith(".localhost") || bare === "::1" || (isIP(bare) === 4 && bare.startsWith("127."));
}

/**
 * The storage address the room API redirected to: absolute and HTTPS. Only a
 * room API on this machine (development) may send the daemon to this
 * machine, over HTTP too; a remote one may not point it at local services.
 */
export function attachmentStorageUrl(location: string | null, apiUrl: string): URL {
  let url: URL;
  try { url = new URL(location ?? ""); } catch { throw new RoomAttachmentDownloadError("unavailable"); }
  const localApi = isLoopbackApi(apiUrl);
  if (url.username || url.password || (namesThisMachine(url.hostname) && !localApi)
    || !(url.protocol === "https:" || (url.protocol === "http:" && localApi && namesThisMachine(url.hostname)))) {
    throw new RoomAttachmentDownloadError("unavailable");
  }
  return url;
}

/**
 * Whether a storage host name resolves to this machine. Checked before the
 * request for a remote room API; a name that does not resolve is refused too.
 * A resolver that answers differently a moment later is not covered.
 */
export async function storageResolvesToThisMachine(hostname: string, signal: AbortSignal,
  resolve: (hostname: string) => Promise<Array<{ address: string }>> = (name) => lookup(name, { all: true, verbatim: true })): Promise<boolean> {
  const bare = hostname.replace(/^\[|\]$/g, "");
  if (isIP(bare)) return isThisMachineAddress(bare);
  signal.throwIfAborted();
  // The system resolver cannot be cancelled, so Stop and the deadline stop the wait for it.
  let detach = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    detach = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    const addresses = await Promise.race([resolve(bare), aborted]);
    return !addresses.length || addresses.some(({ address }) => isThisMachineAddress(address));
  } catch (error) {
    if (signal.aborted) throw error;
    return true;
  } finally { detach(); }
}

/** The work's result, or the abort reason as soon as `signal` aborts; the work itself goes on. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    work.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Two hops, so the worker bearer never leaves the room API: the room route
 * answers with a redirect to presigned object storage, and that address is
 * fetched with no credential and no further redirect. Every failure, a 401 or
 * 403 included, is only this file being unavailable: an older server that
 * does not grant workers this route must not mark the room as refused.
 *
 * A local room's route is in this process and answers with the bytes: its
 * file is read from the local files folder, never from a path the message
 * names, and only when it fits in `maxBytes`.
 */
export async function downloadRoomAttachment(input: {
  roomId: string; apiUrl: string; bearer: string; messageId: string; attachmentId: string;
  maxBytes: number; signal: AbortSignal;
}): Promise<Uint8Array> {
  const localRoom = isLocalRoomApi(input.apiUrl);
  if (!/^msg_[1-9]\d*$/.test(input.messageId) || !Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1
    || !(localRoom ? LOCAL_ROOM_ATTACHMENT_ID.test(input.attachmentId) : /^att_[1-9]\d*$/.test(input.attachmentId))) {
    throw new RoomAttachmentDownloadError("unavailable");
  }
  const unavailable = (): never => {
    input.signal.throwIfAborted();
    throw new RoomAttachmentDownloadError("unavailable");
  };
  if (localRoom) {
    // A file read in this process cannot be cancelled, so Stop and the deadline end the wait for it.
    const response = await untilAborted(roomRequest(`${LOCAL_ROOM_API_ORIGIN}/rooms/${supervisedRoomPath(input.roomId)}/messages/${input.messageId}/attachments/${encodeURIComponent(input.attachmentId)}?max_bytes=${input.maxBytes}`, {
      headers: { authorization: `Bearer ${input.bearer}` }, signal: input.signal,
    }), input.signal).catch(unavailable);
    if (response.status === 413) {
      await response.body?.cancel().catch(() => {});
      throw new RoomAttachmentDownloadError("too_large");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      unavailable();
    }
    try {
      return await boundedBody(response, input.maxBytes);
    } catch (error) {
      if (error instanceof RoomAttachmentDownloadError) throw error;
      return unavailable();
    }
  }
  const redirect = await roomRequest(`${input.apiUrl}/rooms/${supervisedRoomPath(input.roomId)}/messages/${input.messageId}/attachments/${input.attachmentId}`, {
    headers: { authorization: `Bearer ${input.bearer}` }, redirect: "manual", signal: input.signal,
  }).catch(unavailable);
  await redirect.body?.cancel().catch(() => {});
  if (!ATTACHMENT_REDIRECT_STATUSES.has(redirect.status)) unavailable();
  const storage = attachmentStorageUrl(redirect.headers.get("location"), input.apiUrl);
  if (!isLoopbackApi(input.apiUrl) && await storageResolvesToThisMachine(storage.hostname, input.signal)) unavailable();
  const response = await fetch(storage, { redirect: "error", signal: input.signal }).catch(unavailable);
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    unavailable();
  }
  try {
    return await boundedBody(response, input.maxBytes);
  } catch (error) {
    if (error instanceof RoomAttachmentDownloadError) throw error;
    return unavailable();
  }
}

export function lastRoomMessageId(messages: readonly Record<string, unknown>[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const id = messages[index]?.id;
    if (typeof id === "string" && id.trim()) return id;
  }
  return null;
}

// Cloud requests hold daemon serialization locks while they run, and a fetch
// with no deadline waits ~300s for headers by default. Every request therefore
// carries a bounded deadline composed with the caller's signal.
function boundedCloudSignal(signal?: AbortSignal, timeoutMs = CLOUD_REQUEST_TIMEOUT_MS): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

function parseExecutionDelegationResponse(
  value: unknown,
  expectedInstanceId: string,
): RemoteExecutionDelegationRevision {
  const body = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  const raw = body?.delegation;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Execution delegation response omitted its delegation.");
  }
  const record = raw as Record<string, unknown>;
  const requiredString = (name: string): string => {
    const item = record[name];
    if (typeof item !== "string" || !item.trim() || item.trim() !== item) {
      throw new Error(`Execution delegation response omitted ${name}.`);
    }
    return item;
  };
  const timestamp = (name: string, nullable = false): number | null => {
    if (nullable && record[name] === null) return null;
    const parsed = Date.parse(requiredString(name));
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new Error(`Execution delegation response returned invalid ${name}.`);
    }
    return parsed;
  };
  const delegationInstanceId = requiredString("delegation_instance_id");
  const revision = Number(record.revision);
  const scopeSha256 = requiredString("scope_sha256");
  if (delegationInstanceId !== expectedInstanceId
    || !Number.isSafeInteger(revision) || revision < 1
    || record.category !== "file_change" || record.risk_ceiling !== "low"
    || !/^[0-9a-f]{64}$/.test(scopeSha256)) {
    throw new Error("Execution delegation response returned a different authority identity.");
  }
  return {
    delegationInstanceId,
    revision,
    ownerAccountId: requiredString("owner_account_id"),
    roomId: requiredString("room_id"),
    agentKey: requiredString("agent_key"),
    approverAccountId: requiredString("approver_account_id"),
    category: "file_change",
    riskCeiling: "low",
    scopeSha256,
    createdAtMs: timestamp("created_at")!,
    expiresAtMs: timestamp("expires_at")!,
    revokedAtMs: timestamp("revoked_at", true),
  };
}

function parseExecutionDelegationInventoryPage(
  value: unknown,
  key: "delegation_instance_ids" | "decision_ids",
): { ids: string[]; nextCursor: string | null } {
  const body = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  const ids = body?.[key];
  const nextCursor = body?.next_cursor;
  if (!Array.isArray(ids) || ids.length > EXECUTION_DELEGATION_INVENTORY_PAGE_SIZE
    || ids.some((id) => typeof id !== "string" || !id.trim() || id !== id.trim() || id.length > 512)
    || new Set(ids).size !== ids.length
    || ids.some((id, index) => index > 0 && id <= ids[index - 1]!)
    || (nextCursor !== null && (typeof nextCursor !== "string" || !nextCursor.trim()))
    || (nextCursor !== null && nextCursor !== ids.at(-1))) {
    throw new Error("Execution delegation inventory returned an invalid page.");
  }
  return { ids: ids as string[], nextCursor: nextCursor as string | null };
}

export type RoomWorkPublishInput = {
  apiOrigin: string; grantId: string; supervisorGrant: string; grantGeneration: number;
  sessionId: string; roomId: string; sourceMessageId: string; agentKey: string;
  revision: number; summary: RoomAgentWorkSummary; reviewPage?: WorkspaceReviewPage; signal: AbortSignal;
};
export type RoomWorkPublishResult = "acknowledged" | "cleared" | "conflict";

/** Optional evidence publication. This must never renew credentials or execute work. */
export async function publishRoomWork(input: RoomWorkPublishInput): Promise<RoomWorkPublishResult> {
  const summary = parseRoomAgentWorkSummary(input.summary);
  if (!summary || hostGrantApiOrigin(input.apiOrigin) !== input.apiOrigin) throw new Error("Invalid room work publication.");
  const response = await roomRequest(`${input.apiOrigin}/supervisor-host-grants/${encodeURIComponent(input.grantId)}/worker-sessions/${encodeURIComponent(input.sessionId)}/agent-work`, {
    method: "POST", redirect: "error",
    headers: { authorization: `Bearer ${input.supervisorGrant}`, "content-type": "application/json", "x-letagents-supervisor-generation": String(input.grantGeneration) },
    body: JSON.stringify({ generation: input.grantGeneration, room_id: input.roomId,
      source_message_id: input.sourceMessageId, revision: input.revision, summary, ...(input.reviewPage ? { review_page: input.reviewPage } : {}) }),
    signal: boundedCloudSignal(input.signal),
  });
  const body = await response.json() as Record<string, unknown>;
  if (response.status === 409 && body.code === "payload_cleared") return "cleared";
  if (response.status === 409 && ["publisher_conflict", "revision_conflict"].includes(String(body.code))) return "conflict";
  if (!response.ok) throw new SupervisorGrantRequestError(response.status, "Room work publication");
  const work = body.work as Record<string, unknown> | undefined;
  if (!["created", "updated", "replayed"].includes(String(body.status)) || !work
    || typeof work.attempt_id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(work.attempt_id)
    || work.room_id !== input.roomId || work.source_message_id !== input.sourceMessageId
    || work.agent_key !== input.agentKey || work.revision !== input.revision) {
    throw new Error("Room work publication returned a different receipt.");
  }
  if (body.status === "replayed" && isClearedRoomAgentWorkSummary(work.summary)) return "cleared";
  const accepted = parseRoomAgentWorkSummary(work.summary);
  if (!accepted || JSON.stringify(accepted) !== JSON.stringify(summary)) throw new Error("Room work publication returned a different summary.");
  if (input.reviewPage && (body.review_digest !== input.reviewPage.digest || body.review_page !== input.reviewPage.index)) throw new Error("Workspace review page was not acknowledged.");
  return "acknowledged";
}

/** How long a turn waits for its thread's images to be found; the thread is optional. */
const THREAD_READ_TIMEOUT_MS = 4_000;

/**
 * The root and the latest replies before one message of a thread, for the
 * images a turn may carry. Optional: any failure, a refused bearer included,
 * is null, so it never marks the room as refused or holds a turn back long.
 */
export async function readRoomThread(input: {
  roomId: string; apiUrl: string; bearer: string; rootMessageId: string; beforeMessageId: string;
  limit: number; signal: AbortSignal;
}): Promise<{ root: Record<string, unknown>; replies: Array<Record<string, unknown>> } | null> {
  const messageId = /^msg_[1-9]\d*$/;
  if (!messageId.test(input.rootMessageId) || !messageId.test(input.beforeMessageId)
    || !Number.isSafeInteger(input.limit) || input.limit < 1) return null;
  const origin = isLocalRoomApi(input.apiUrl) ? LOCAL_ROOM_API_ORIGIN : input.apiUrl;
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(THREAD_READ_TIMEOUT_MS)]);
  try {
    const response = await untilAborted(roomRequest(`${origin}/rooms/${supervisedRoomPath(input.roomId)}/messages/${input.rootMessageId}/thread?before=${input.beforeMessageId}&limit=${input.limit}`, {
      headers: { authorization: `Bearer ${input.bearer}` }, redirect: "error", signal,
    }), signal);
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    const body = await untilAborted(response.json() as Promise<unknown>, signal);
    const page = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
    const isMessage = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object"
      && !Array.isArray(value) && messageId.test(String((value as Record<string, unknown>).id));
    if (page?.room_id !== input.roomId || !isMessage(page.root) || page.root.id !== input.rootMessageId
      || !Array.isArray(page.replies) || !page.replies.every(isMessage)) return null;
    return { root: page.root, replies: page.replies.slice(-input.limit) };
  } catch {
    input.signal.throwIfAborted();
    return null;
  }
}

/** The daemon talks to the room API only through the live worker bearer. */
export const productionSupervisedDeliveryHttp: SupervisedDeliveryHttp = {
  admissionOwnsInitialCursor: true,
  async context(input) {
    if (isLocalRoomApi(input.apiUrl)) return null;
    // Use the same bounded network allowance as other cloud reads. A separate
    // five-second deadline exhausted preparation retries on slow connections
    // before any model work could start. Stop still cancels immediately.
    const response = await roomRequest(`${input.apiUrl}/rooms/${supervisedRoomPath(input.roomId)}/messages?before=latest&limit=30&context_only=true`, {
      headers: { authorization: `Bearer ${input.bearer}` }, redirect: "error",
      signal: boundedCloudSignal(input.signal),
    }).catch((error: unknown) => {
      if (input.signal.aborted) throw input.signal.reason;
      throw new Error(`Room context read failed during request (${error instanceof Error ? error.name : "transport error"}).`, { cause: error });
    });
    if (response.status === 401 || response.status === 403) {
      throw new SupervisedRoomAuthorizationError(`Room context read failed with HTTP ${response.status}.`, response.status);
    }
    if (!response.ok) throw new Error(`Room context read failed with HTTP ${response.status}.`);
    const body = await response.json().catch((error: unknown) => {
      if (input.signal.aborted) throw input.signal.reason;
      // JSON parser messages can contain response text; keep it out of the
      // user-visible diagnostic while retaining the cause for debugging.
      throw new Error(`Room context read failed during response (${error instanceof Error ? error.name : "body error"}).`, { cause: error });
    }) as Record<string, unknown>;
    if (body?.room_id !== input.roomId) throw new Error("Room context response belongs to another room.");
    // Older history routes ignore the optional query. Their held result is
    // not fresh awareness; retain legacy behavior during server-first rollout.
    if (body.context_only === undefined && Array.isArray(body.messages)) return null;
    if (body.context_only !== true || !Array.isArray(body.messages) || body.messages.length > 30
      || body.messages.some(value => !value || typeof value !== "object" || Array.isArray(value)
        || typeof value.id !== "string" || !/^msg_[1-9]\d*$/.test(value.id)
        || typeof value.text !== "string" || value.activation !== undefined)) {
      throw new Error("Room context response is invalid.");
    }
    return body.messages;
  },
  async historySummary(input) {
    // Null: the room has no summary to give (local room, older server, off,
    // no summarizer, nothing yet). A failed read throws, so a later turn asks again.
    if (isLocalRoomApi(input.apiUrl)) return null;
    const response = await roomRequest(`${input.apiUrl}/rooms/${supervisedRoomPath(input.roomId)}/history-summary?max_lines=${ROOM_HISTORY_TURN_VIEW_LINES}`, {
      headers: { authorization: `Bearer ${input.bearer}` }, redirect: "error",
      // Short: a first turn waits for this read, and the summary is optional.
      signal: AbortSignal.any([input.signal, AbortSignal.timeout(4_000)]),
    });
    // A refused bearer is found and handled by the turn's own context read.
    if (response.status === 404 || response.status === 409) return null;
    if (!response.ok) throw new Error(`Room history summary read failed with HTTP ${response.status}.`);
    const body = await response.json() as Record<string, unknown>;
    return body?.room_id === input.roomId ? roomHistoryTurnSummary(body) : null;
  },
  async reportNoReply(input) {
    // The local adapter has no self-receipt PUT route. Never interpret its
    // fallback history response as an acknowledgment.
    if (isLocalRoomApi(input.apiUrl) || !/^msg_[1-9]\d*$/.test(input.sourceMessageId)) return;
    const response = await roomRequest(`${input.apiUrl}/rooms/${supervisedRoomPath(input.roomId)}/messages/${input.sourceMessageId}/agent-receipts/self`, {
      method: "PUT", redirect: "error",
      headers: { authorization: `Bearer ${input.bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ receipt_state: "no_reply" }),
      signal: AbortSignal.any([input.signal, AbortSignal.timeout(2_000)]),
    });
    if (!response.ok) throw new Error(`No-reply receipt failed with HTTP ${response.status}.`);
    const body = await response.json() as Record<string, unknown>;
    if (body?.success !== true || body.receipt_state !== "no_reply"
      || typeof body.receipt_id !== "string" || !body.receipt_id.trim()) {
      throw new Error("No-reply receipt was not acknowledged.");
    }
  },
  async yieldReplyTurn(input) {
    if (isLocalRoomApi(input.apiUrl) || !/^msg_[1-9]\d*$/.test(input.sourceMessageId)) return;
    const response = await roomRequest(`${input.apiUrl}/rooms/${supervisedRoomPath(input.roomId)}/messages/${input.sourceMessageId}/agent-receipts/self`, {
      method: "PUT", redirect: "error",
      headers: { authorization: `Bearer ${input.bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ yield_reply_turn: true }),
      signal: AbortSignal.any([input.signal, AbortSignal.timeout(2_000)]),
    });
    if (!response.ok) throw new Error(`Reply-turn yield failed with HTTP ${response.status}.`);
    const body = await response.json() as Record<string, unknown>;
    if (body?.success !== true || body.reply_turn_yielded !== true
      || typeof body.receipt_id !== "string" || !body.receipt_id.trim()) {
      throw new Error("Reply-turn yield was not acknowledged.");
    }
  },
  async ownedTasks(input) {
    const tasks: Array<{ id: string; title: string; leaseId: string; epoch: number }> = [];
    const read = async (suffix: string) => {
      const response = await roomRequest(`${input.apiUrl}/rooms/${supervisedRoomPath(input.roomId)}/tasks${suffix}`, {
        headers: { authorization: `Bearer ${input.bearer}` }, signal: boundedCloudSignal(input.signal),
      });
      if (response.status === 404 && suffix.startsWith("/")) return null;
      if (!response.ok) throw new Error(`Task ownership read failed with HTTP ${response.status}.`);
      const body = await response.json() as Record<string, unknown>;
      if (body.room_id !== input.roomId) throw new Error("Task ownership response belongs to another room.");
      return body;
    };
    const retainOwned = (value: unknown) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid task ownership response.");
      const task = value as Record<string, unknown>;
      if (typeof task.id !== "string" || !task.id || typeof task.title !== "string" || !Array.isArray(task.active_leases)) throw new Error("Task ownership response omitted its identity or leases.");
      if (task.status !== "assigned" && task.status !== "in_progress") return;
      const leases = task.active_leases.filter((value: unknown) => {
        if (!value || typeof value !== "object") return false;
        const lease = value as Record<string, unknown>;
        return lease.kind === "work" && lease.status === "active" && lease.task_id === task.id
          && lease.room_id === input.roomId && lease.agent_session_id === input.agentSessionId
          && (!input.heldBefore || (typeof lease.created_at === "string" && Date.parse(lease.created_at) <= Date.parse(input.heldBefore)))
          && (lease.expires_at === null || (typeof lease.expires_at === "string" && Date.parse(lease.expires_at) > Date.now()));
      }) as Array<Record<string, unknown>>;
      if (leases.length !== 1) return;
      const lease = leases[0]!;
      if (typeof lease.id !== "string" || !lease.id || !Number.isSafeInteger(lease.epoch) || Number(lease.epoch) < 0) throw new Error("Task lease has no valid fence.");
      tasks.push({ id: task.id, title: task.title.slice(0, 512), leaseId: lease.id, epoch: Number(lease.epoch) });
      if (tasks.length > 100) throw new Error("Too many owned tasks to recover safely in one continuation.");
    };
    if (input.taskIds) {
      for (const id of input.taskIds) {
        const task = await read(`/${encodeURIComponent(id)}`);
        if (task) { if (task.id !== id) throw new Error("Task lookup returned a different task."); retainOwned(task); }
      }
      return tasks;
    }
    let after: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const query = new URLSearchParams({ open: "true", limit: "100" });
      if (after) query.set("after", after);
      const body = await read(`?${query}`);
      if (!body || !Array.isArray(body.tasks) || typeof body.has_more !== "boolean") throw new Error("Task list response is incomplete.");
      for (const task of body.tasks) retainOwned(task);
      if (!body.has_more) return tasks;
      const next = (body.tasks.at(-1) as Record<string, unknown> | undefined)?.id;
      if (typeof next !== "string" || !next || next === after) throw new Error("Task list cursor did not advance.");
      after = next;
    }
    throw new Error("Task ownership inventory exceeded its bounded read budget.");
  },
  async poll(input) {
    const query = new URLSearchParams({ timeout: String(SUPERVISED_ROOM_POLL_TIMEOUT_MS) });
    if (input.afterMessageId) query.set("after", input.afterMessageId);
    const response = await roomRequest(`${input.apiUrl}/rooms/${supervisedRoomPath(input.roomId)}/messages/poll?${query}`, {
      headers: { authorization: `Bearer ${input.bearer}` },
      signal: boundedCloudSignal(input.signal, SUPERVISED_ROOM_POLL_TIMEOUT_MS + 20_000),
    });
    if (response.status === 401 || response.status === 403) {
      throw new SupervisedRoomAuthorizationError(`Supervised room poll failed with HTTP ${response.status}.`, response.status);
    }
    if (!response.ok) throw new Error(`Supervised room poll failed with HTTP ${response.status}.`);
    return await response.json() as SupervisedPollResponse;
  },
  async latest(input) {
    const response = await roomRequest(`${input.apiUrl}/rooms/${supervisedRoomPath(input.roomId)}/messages?limit=1&before=latest`, {
      headers: { authorization: `Bearer ${input.bearer}` }, signal: boundedCloudSignal(input.signal),
    });
    if (!response.ok) throw new Error(`Supervised room tail read failed with HTTP ${response.status}.`);
    return await response.json() as { messages?: Array<Record<string, unknown>> };
  },
  downloadAttachment: downloadRoomAttachment,
  thread: readRoomThread,
  async joinRoom(input) {
    const response = await roomRequest(`${input.apiUrl}/rooms/${supervisedRoomPath(input.roomId)}/join`, {
      method: "POST", headers: { authorization: `Bearer ${input.bearer}`, "content-type": "application/json" }, body: "{}", signal: boundedCloudSignal(input.signal),
    });
    if (!response.ok) throw new SupervisorGrantRequestError(response.status, "Destination room join");
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    const roomId = typeof body.room_id === "string" && body.room_id.trim() ? body.room_id.trim()
      : typeof body.id === "string" && body.id.trim() ? body.id.trim() : input.roomId;
    return { roomId };
  },
  async publish(input) {
    const send = (gif: typeof input.gif) => roomRequest(`${input.apiUrl}/rooms/${supervisedRoomPath(input.roomId)}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${input.bearer}`, "content-type": "application/json" },
      body: JSON.stringify({
        sender: "supervised-daemon",
        text: input.text,
        ...(gif ? { gif } : {}),
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        client_message_id: input.clientMessageId,
        ...(input.replyTo && input.threadRootId
          ? { reply_to: input.replyTo, thread_root_id: input.threadRootId }
          : {}),
      }),
      signal: boundedCloudSignal(input.signal),
    });
    let response = await send(input.gif);
    if (input.gif && response.status === 400) {
      const failure = await response.clone().json().catch(() => ({})) as { error?: unknown };
      if (typeof failure.error === "string" && failure.error.startsWith("expressions_disabled:")) {
        response = await send(null);
      }
    }
    if (!response.ok) throw new Error(`Supervised room publication failed with HTTP ${response.status}.`);
    const message = await response.json() as Record<string, unknown>;
    const messageId = typeof message.id === "string" && message.id.trim() ? message.id : null;
    const roomId = typeof message.room_id === "string" && message.room_id.trim() ? message.room_id : null;
    if (!messageId || !roomId || roomId !== input.roomId) throw new Error("Supervised room publication response omitted its canonical message identity.");
    return { messageId, roomId };
  },
  async stageAttachment(input) {
    const staged = await stageCloudMessageAttachment({
      requestJson: async (path, init) => {
        const response = await roomRequest(`${input.apiUrl}${path}`, {
          ...init,
          headers: { ...init.headers, authorization: `Bearer ${input.bearer}` },
          signal: boundedCloudSignal(input.signal),
        });
        // The caller turns any staging failure into a note on the reply, so a
        // server without worker upload routes still gets the reply text.
        if (!response.ok) throw new Error(`Supervised attachment staging failed with HTTP ${response.status}.`);
        return response.status === 204 ? undefined : await response.json();
      },
      fetch: (url, init) => fetch(url, { ...init, signal: boundedCloudSignal(input.signal, ATTACHMENT_UPLOAD_TIMEOUT_MS) }),
    }, {
      roomPath: `/rooms/${supervisedRoomPath(input.roomId)}`,
      fileName: input.fileName,
      mimeType: input.mimeType,
      bytes: input.bytes,
    });
    return { uploadId: staged.uploadId };
  },
  async discardAttachment(input) {
    const response = await roomRequest(`${input.apiUrl}/rooms/${supervisedRoomPath(input.roomId)}/attachments/uploads/${encodeURIComponent(input.uploadId)}`, {
      method: "DELETE", headers: { authorization: `Bearer ${input.bearer}` }, signal: boundedCloudSignal(input.signal),
    });
    if (!response.ok) throw new Error(`Supervised attachment discard failed with HTTP ${response.status}.`);
  },
};

/** Host grants and worker bearers are process-memory values, never daemon state. */
function taskWorkLeases(value: unknown, roomId: string): CloudWorkLease[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Lease inventory omitted its task.");
  const task = value as Record<string, unknown>;
  if (typeof task.id !== "string" || !task.id || task.room_id !== roomId || !Array.isArray(task.active_leases)) {
    throw new Error("Lease inventory returned an invalid task identity.");
  }
  return task.active_leases.flatMap(value => {
    if (!value || typeof value !== "object") throw new Error("Lease inventory returned an invalid lease.");
    const lease = value as Record<string, unknown>;
    if (lease.kind !== "work" || lease.status !== "active") return [];
    return [parseWorkLease(lease, roomId, String(task.id))];
  });
}
function parseWorkLease(lease: Record<string, unknown>, roomId: string, taskId: string): CloudWorkLease {
  if (lease.room_id !== roomId || lease.task_id !== taskId || lease.kind !== "work" || lease.status !== "active"
    || !Number.isSafeInteger(lease.epoch) || Number(lease.epoch) < 0
    || ["id", "agent_key"].some(key => typeof lease[key] !== "string" || !lease[key])) {
    throw new Error("Lease inventory returned an invalid fence.");
  }
  // Legacy/manual leases can lack a worker session or instance; they must never
  // become candidates for a supervised-worker transfer.
  if (["agent_session_id", "agent_instance_id"].some(key => lease[key] !== null && typeof lease[key] !== "string")) {
    throw new Error("Lease inventory returned an invalid worker identity.");
  }
  return { id: String(lease.id), room_id: roomId, task_id: taskId, epoch: Number(lease.epoch),
    agent_key: String(lease.agent_key), agent_session_id: lease.agent_session_id as string ?? "",
    agent_instance_id: lease.agent_instance_id as string ?? "" };
}
async function readLeaseTask(input: LeaseReadInput, suffix: string): Promise<Record<string, unknown> | null> {
  const response = await roomRequest(`${hostGrantApiOrigin(input.apiUrl)}/rooms/${supervisedRoomPath(input.roomId)}/tasks${suffix}`, {
    headers: { authorization: `Bearer ${input.bearer}` }, signal: boundedCloudSignal(input.signal), redirect: "error",
  });
  if (response.status === 404 && suffix.startsWith("/")) return null;
  if (!response.ok) throw new SupervisorGrantRequestError(response.status, "Worker lease inventory");
  const body = await response.json() as Record<string, unknown>;
  if (body.room_id !== input.roomId) throw new Error("Worker lease inventory belongs to another room.");
  return body;
}
async function leaseMutation(input: LeaseAttestationInput, action: "attestation" | "rebind", extra: Record<string, string>) {
  const response = await roomRequest(`${hostGrantApiOrigin(input.apiUrl)}/supervisor-host-grants/${encodeURIComponent(input.grantId)}/leases/${encodeURIComponent(input.lease.id)}/${action}`, {
    method: "POST", redirect: "error",
    headers: { authorization: `Bearer ${input.supervisorGrant}`, "content-type": "application/json", "x-letagents-supervisor-generation": String(input.grantGeneration) },
    body: JSON.stringify({ expected_epoch: input.lease.epoch, from_agent_session_id: input.lease.agent_session_id,
      work_attempt_id: input.workAttemptId, execution_generation_id: input.executionGenerationId, ...extra }),
    signal: boundedCloudSignal(input.signal),
  });
  if (!response.ok) throw new SupervisorGrantRequestError(response.status, `Worker lease ${action}`);
  return await response.json() as Record<string, unknown>;
}

export const productionSupervisorGrantHttp: SupervisorGrantHttp & Required<Pick<SupervisorGrantHttp,
  "getExecutionDelegationDecision" | "listExecutionDelegationDecisionIds">> = {
  async listWorkLeases(input) {
    const leases: CloudWorkLease[] = [];
    const seenTasks = new Set<string>();
    let after: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      // Include In review and Merged: ownership outlives the implementation phase.
      const query = new URLSearchParams({ limit: "100" });
      if (after) query.set("after", after);
      const body = await readLeaseTask(input, `?${query}`);
      if (!body || !Array.isArray(body.tasks) || typeof body.has_more !== "boolean") throw new Error("Lease inventory is incomplete.");
      for (const task of body.tasks) {
        const selected = taskWorkLeases(task, input.roomId);
        const id = String(task.id);
        if (seenTasks.has(id)) throw new Error("Lease inventory repeated a task.");
        seenTasks.add(id);
        leases.push(...selected);
      }
      if (!body.has_more) return leases;
      const next = body.tasks.at(-1)?.id;
      if (typeof next !== "string" || !next || next === after) throw new Error("Lease inventory cursor did not advance.");
      after = next;
    }
    throw new Error("Worker lease inventory exceeded its bounded read budget.");
  },
  async readWorkLease(input) {
    const task = await readLeaseTask(input, `/${encodeURIComponent(input.taskId)}`);
    if (!task) return null;
    if (task.id !== input.taskId) throw new Error("Worker lease read returned a different task.");
    return taskWorkLeases(task, input.roomId).find(lease => lease.id === input.leaseId) ?? null;
  },
  async attestWorkLease(input) {
    const receipt = await leaseMutation(input, "attestation", { cause: input.cause });
    if (typeof receipt.id !== "string" || !receipt.id || receipt.lease_id !== input.lease.id
      || receipt.epoch !== input.lease.epoch || receipt.from_agent_session_id !== input.lease.agent_session_id
      || receipt.grant_id !== input.grantId || !Number.isSafeInteger(receipt.supervisor_generation)
      || Number(receipt.supervisor_generation) < 1 || Number(receipt.supervisor_generation) > input.grantGeneration
      || receipt.work_attempt_id !== input.workAttemptId || receipt.execution_generation_id !== input.executionGenerationId
      || receipt.cause !== input.cause || receipt.consumed_at !== null) throw new Error("Lease attestation returned a different proof.");
    return receipt.id;
  },
  async rebindWorkLease(input) {
    const lease = parseWorkLease(await leaseMutation(input, "rebind", {
      attestation_id: input.attestationId, to_agent_session_id: input.toSessionId,
    }), input.lease.room_id, input.lease.task_id);
    if (lease.id !== input.lease.id || lease.agent_session_id !== input.toSessionId || lease.epoch !== input.lease.epoch + 1
      || lease.agent_key !== input.lease.agent_key || lease.agent_instance_id !== input.lease.agent_instance_id) {
      throw new Error("Lease rebind returned a different successor fence.");
    }
    return lease;
  },
  async createWorkerSession(input) {
    const ideLabel = supervisedProviderLabel(input.provider);
    const response = await roomRequest(`${input.apiUrl}/supervisor-host-grants/${encodeURIComponent(input.grantId)}/worker-sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${input.supervisorGrant}`, "content-type": "application/json", "x-letagents-supervisor-generation": String(input.grantGeneration) },
      body: JSON.stringify({
        generation: input.grantGeneration,
        room_id: input.roomId,
        agent_key: input.agentKey,
        agent_instance_id: input.agentInstanceId,
        display_name: input.displayName,
        runtime: input.provider,
        ide_label: ideLabel,
        // Routing needs more than the runtime: humans address agents by model
        // and by the role their charter gave them.
        model: input.model ?? null,
        charter: input.charter ?? null,
      }),
      signal: boundedCloudSignal(input.signal),
    });
    if (!response.ok) throw new SupervisorGrantRequestError(response.status, "Supervisor worker session mint");
    const body = await response.json() as Record<string, unknown>;
    const requireString = (name: string) => {
      const value = body[name];
      if (typeof value !== "string" || !value.trim()) throw new Error(`Supervisor worker session response omitted ${name}.`);
      return value;
    };
    const sessionKind = requireString("session_kind");
    if (sessionKind !== "worker") throw new Error("Supervisor worker session response returned a non-worker identity.");
    const endedAt = body.ended_at;
    if (endedAt !== null) throw new Error("Supervisor worker session response returned an ended identity.");
    const agentSession: DaemonToolAgentSession = {
      session_id: requireString("session_id"), session_token: "", room_id: requireString("room_id"),
      session_kind: "worker", runtime: requireString("runtime"), actor_label: requireString("actor_label"),
      agent_key: requireString("agent_key"), agent_instance_id: requireString("agent_instance_id"),
      display_name: requireString("display_name"), owner_label: requireString("owner_label"),
      ide_label: requireString("ide_label"), created_at: requireString("created_at"),
      updated_at: requireString("updated_at"), last_seen_at: requireString("last_seen_at"), ended_at: null,
    };
    if (agentSession.room_id !== input.roomId
      || agentSession.runtime !== input.provider
      || agentSession.agent_key !== input.agentKey
      || agentSession.agent_instance_id !== input.agentInstanceId) {
      throw new Error("Supervisor worker session response returned a different authority identity.");
    }
    return {
      sessionId: agentSession.session_id, bearer: requireString("worker_bearer"), bearerId: requireString("worker_bearer_id"),
      expiresAt: typeof body.worker_bearer_expires_at === "string" ? body.worker_bearer_expires_at : null,
      agentSession,
    };
  },
  async endWorkerSession(input) {
    const response = await roomRequest(`${input.apiUrl}/supervisor-host-grants/${encodeURIComponent(input.grantId)}/worker-sessions/${encodeURIComponent(input.sessionId)}/end`, {
      method: "POST",
      headers: { authorization: `Bearer ${input.supervisorGrant}`, "content-type": "application/json", "x-letagents-supervisor-generation": String(input.grantGeneration) },
      body: JSON.stringify({ generation: input.grantGeneration, ...(input.restarting ? { restarting: true } : {}) }),
      signal: boundedCloudSignal(),
    });
    if (!response.ok) throw new SupervisorGrantRequestError(response.status, "Supervisor worker session end");
  },
  async renewHostGrant(input) {
    const response = await roomRequest(`${input.apiUrl}/supervisor-host-grants/${encodeURIComponent(input.grantId)}/renew`, {
      method: "POST",
      headers: { authorization: `Bearer ${input.supervisorGrant}`, "content-type": "application/json", "x-letagents-supervisor-generation": String(input.grantGeneration) },
      body: JSON.stringify({
        generation: input.grantGeneration, host_id: input.hostId,
        installation_id: input.installationId, ttl_ms: input.ttlMs,
      }),
      signal: boundedCloudSignal(),
    });
    if (!response.ok) throw new SupervisorGrantRequestError(response.status, "Supervisor host grant renewal");
    const body = await response.json() as Record<string, unknown>;
    const requireString = (name: string) => {
      const value = body[name];
      if (typeof value !== "string" || !value.trim()) throw new Error(`Supervisor grant renewal response omitted ${name}.`);
      return value;
    };
    const generation = Number(body.current_generation);
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("Supervisor grant renewal response omitted current_generation.");
    return {
      grantId: requireString("grant_id"), supervisorGrant: requireString("supervisor_grant"),
      grantGeneration: generation, expiresAt: requireString("expires_at"),
    };
  },
  async getExecutionDelegation(input) {
    const apiOrigin = hostGrantApiOrigin(input.apiUrl);
    const response = await roomRequest(
      `${apiOrigin}/supervisor-host-grants/${encodeURIComponent(input.grantId)}/execution-delegations/${encodeURIComponent(input.delegationInstanceId)}`,
      {
        headers: {
          authorization: `Bearer ${input.supervisorGrant}`,
          "x-letagents-supervisor-generation": String(input.grantGeneration),
        },
        signal: boundedCloudSignal(input.signal),
      },
    );
    if (!response.ok) throw new SupervisorGrantRequestError(response.status, "Execution delegation read");
    return parseExecutionDelegationResponse(await response.json(), input.delegationInstanceId);
  },
  async listExecutionDelegationIds(input) {
    const apiOrigin = hostGrantApiOrigin(input.apiUrl);
    const query = new URLSearchParams({ room_id: input.roomId, agent_key: input.agentKey });
    if (input.after) query.set("after", input.after);
    const response = await roomRequest(
      `${apiOrigin}/supervisor-host-grants/${encodeURIComponent(input.grantId)}/execution-delegations?${query}`,
      {
        headers: {
          authorization: `Bearer ${input.supervisorGrant}`,
          "x-letagents-supervisor-generation": String(input.grantGeneration),
        },
        signal: boundedCloudSignal(input.signal),
      },
    );
    if (!response.ok) throw new SupervisorGrantRequestError(response.status, "Execution delegation inventory");
    const page = parseExecutionDelegationInventoryPage(await response.json(), "delegation_instance_ids");
    return { delegationInstanceIds: page.ids, nextCursor: page.nextCursor };
  },
  async getExecutionDelegationDecision(input) {
    const apiOrigin = hostGrantApiOrigin(input.apiUrl);
    const response = await roomRequest(
      `${apiOrigin}/supervisor-host-grants/${encodeURIComponent(input.grantId)}/execution-delegation-decisions/${encodeURIComponent(input.decisionId)}`,
      {
        headers: {
          authorization: `Bearer ${input.supervisorGrant}`,
          "x-letagents-supervisor-generation": String(input.grantGeneration),
        },
        signal: boundedCloudSignal(input.signal),
      },
    );
    if (!response.ok) throw new SupervisorGrantRequestError(response.status, "Execution delegation decision read");
    const body = await response.json() as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).length !== 1 || !Object.hasOwn(body, "decision")) {
      throw new Error("Execution delegation decision response returned an invalid wrapper.");
    }
    const decision = parseExecutionDelegationDecisionIntent(body.decision);
    if (!decision || decision.decision_id !== input.decisionId) {
      throw new Error("Execution delegation decision response returned a different intent.");
    }
    return decision;
  },
  async listExecutionDelegationDecisionIds(input) {
    const apiOrigin = hostGrantApiOrigin(input.apiUrl);
    const query = new URLSearchParams({ room_id: input.roomId, agent_key: input.agentKey });
    if (input.after) query.set("after", input.after);
    const response = await roomRequest(
      `${apiOrigin}/supervisor-host-grants/${encodeURIComponent(input.grantId)}/execution-delegation-decisions?${query}`,
      {
        headers: {
          authorization: `Bearer ${input.supervisorGrant}`,
          "x-letagents-supervisor-generation": String(input.grantGeneration),
        },
        signal: boundedCloudSignal(input.signal),
      },
    );
    if (!response.ok) throw new SupervisorGrantRequestError(response.status, "Execution delegation decision inventory");
    const page = parseExecutionDelegationInventoryPage(await response.json(), "decision_ids");
    return { decisionIds: page.ids, nextCursor: page.nextCursor };
  },
};

export async function publishWorkerNativeActivity(input: {
  apiUrl: string;
  roomId: string;
  agentSessionId: string;
  bearer: string;
  observedAt: string;
  sequence: number;
  method: string;
  status: "working" | "idle";
  operation: string;
  /** What the working agent does, in one public line; null clears it. Older servers ignore the field. */
  activitySummary?: string | null;
}): Promise<boolean> {
  const roomPath = supervisedRoomPath(input.roomId);
  const endpoint = `${input.apiUrl}/rooms/${roomPath}/agent-sessions/${encodeURIComponent(input.agentSessionId)}/native-activity`;
  const response = await roomRequest(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${input.bearer}`, "content-type": "application/json" },
    body: JSON.stringify({
      observed_at: input.observedAt,
      sequence: input.sequence,
      method: input.method,
      status: input.status,
      activity_summary: input.status === "working" ? input.activitySummary ?? null : null,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new NativeActivityRejectedError(
      `Native activity endpoint rejected ${input.operation} with HTTP ${response.status}.`,
      response.status,
    );
  }
  const payload = await response.json() as { accepted?: boolean };
  return payload.accepted !== false;
}

/** Room waits are normally long polls, so reachability must outlive one poll. */
export function workplaceLivenessStaleAfterMs(rawPollMaxMs = process.env.LETAGENTS_POLL_MAX_MS): number {
  const parsed = rawPollMaxMs == null || rawPollMaxMs === ""
    ? Number.NaN
    : Number.parseInt(String(rawPollMaxMs), 10);
  const pollMaxMs = Number.isNaN(parsed) || parsed < 1_000
    ? DEFAULT_ROOM_POLL_MAX_MS
    : Math.min(parsed, MAX_ROOM_POLL_MAX_MS);
  return Math.max(NATIVE_LIVENESS_STALE_AFTER_MS, pollMaxMs + LIVENESS_GRACE_MS);
}

/** A request about an agent's shared live activity that the room server refused. */
export class LiveActivityRejectedError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** The room server predates live sessions: it would keep the snapshot as an ordinary reasoning session. */
export class LiveActivityUnsupportedError extends Error {
  readonly unsupported = true;
  constructor() {
    super("The room server does not support shared live activity.");
  }
}

type LiveActivityRequest = { apiUrl: string; roomId: string; bearer: string };

/**
 * Start the live session of the agent's current turn. The server replaces
 * the agent's earlier live sessions in the room. Returns the new session id.
 */
export async function createLiveActivitySession(input: LiveActivityRequest & { body: { summary: string; live: unknown } }): Promise<string> {
  const response = await roomRequest(`${input.apiUrl}/rooms/${supervisedRoomPath(input.roomId)}/reasoning-sessions`, {
    method: "POST",
    headers: { authorization: `Bearer ${input.bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ kind: "live", summary: input.body.summary, live: input.body.live }),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new LiveActivityRejectedError(`Live activity was refused with HTTP ${response.status}.`, response.status);
  const payload = await response.json() as { session?: { id?: unknown; kind?: unknown } };
  if (typeof payload.session?.id !== "string" || !payload.session.id) throw new Error("The room server returned no live session.");
  if (payload.session.kind !== "live") {
    // An older server ignored the kind and opened a reasoning session: close it, so no reasoning list shows it.
    await roomRequest(`${input.apiUrl}/rooms/${supervisedRoomPath(input.roomId)}/reasoning-sessions/${encodeURIComponent(payload.session.id)}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${input.bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ closed_at: new Date().toISOString() }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
    throw new LiveActivityUnsupportedError();
  }
  return payload.session.id;
}

/** Replace the snapshot of the agent's live session. False when the session is gone. */
export async function updateLiveActivitySession(input: LiveActivityRequest & { sessionId: string; body: { summary: string; live: unknown } }): Promise<boolean> {
  const response = await roomRequest(`${input.apiUrl}/rooms/${supervisedRoomPath(input.roomId)}/reasoning-sessions/${encodeURIComponent(input.sessionId)}/updates`, {
    method: "POST",
    headers: { authorization: `Bearer ${input.bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ summary: input.body.summary, live: input.body.live }),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404) return false;
  if (!response.ok) throw new LiveActivityRejectedError(`Live activity was refused with HTTP ${response.status}.`, response.status);
  return true;
}

/** Remove every live session of the agent in the room, so no member sees its activity any more. */
export async function withdrawLiveActivity(input: LiveActivityRequest): Promise<void> {
  const response = await roomRequest(`${input.apiUrl}/rooms/${supervisedRoomPath(input.roomId)}/live-activity`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${input.bearer}` },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  // A server without the route never stored a live session, so nothing is left to remove. It answers 404 or
  // 405, or refuses a worker bearer on a route it does not know with this exact 403; any other refusal stands.
  if (response.status === 404 || response.status === 405) return;
  if (response.status === 403) {
    const payload = await response.json().catch(() => null) as { error?: unknown } | null;
    if (payload?.error === "This worker bearer is not authorized for the requested route.") return;
  }
  if (!response.ok) throw new LiveActivityRejectedError(`Withdrawing live activity was refused with HTTP ${response.status}.`, response.status);
}
