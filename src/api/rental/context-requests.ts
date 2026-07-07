/**
 * Context Access Requests Service
 *
 * When a rented provider agent needs context outside the approved scope,
 * it files a request here instead of getting a silent file_not_found.
 * The renter reviews pending requests and approves or denies each one.
 * An approval best-effort materializes the file into the session
 * workspace so the Context Broker can serve — and ledger — it.
 *
 * Deps are semantic operations (like heartbeat.ts) so tests run without
 * a live database.
 */

import { and, desc, eq } from "drizzle-orm";
import { randomUUID } from "crypto";

import {
  CONTEXT_ACCESS_APPROVED,
  CONTEXT_ACCESS_DENIED,
  CONTEXT_ACCESS_REQUESTED,
} from "./activity-event-types.js";
import type { EmitActivityEventInput } from "./activity-emitter.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ContextRequestType =
  | "read_file"
  | "search"
  | "directory_listing"
  | "command_output";

export type ContextRequestStatus = "pending" | "approved" | "denied" | "expired";

export interface ContextRequestRecord {
  id: string;
  session_id: string;
  path: string;
  request_type: ContextRequestType;
  status: ContextRequestStatus;
  reason: string | null;
  requested_by: string | null;
  decided_by: string | null;
  decided_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateContextRequestInput {
  sessionId: string;
  path: string;
  reason?: string;
  requestType?: ContextRequestType;
  requestedBy?: string;
}

export interface DecideContextRequestInput {
  sessionId: string;
  requestId: string;
  decision: "approved" | "denied";
  decidedBy: string;
}

export interface DecideContextRequestResult {
  request: ContextRequestRecord;
  /** True when the approved file landed in the session workspace. */
  materialized: boolean;
  /** Why materialization was skipped/failed (approval still recorded). */
  materializeReason?: string;
}

export interface ContextRequestsDeps {
  findPendingByPath(
    sessionId: string,
    path: string,
  ): Promise<ContextRequestRecord | null>;
  /** Most recent approved request for the path, for delivery retries. */
  findApprovedByPath?(
    sessionId: string,
    path: string,
  ): Promise<ContextRequestRecord | null>;
  getById(
    sessionId: string,
    requestId: string,
  ): Promise<ContextRequestRecord | null>;
  insert(row: ContextRequestRecord): Promise<ContextRequestRecord>;
  list(sessionId: string): Promise<ContextRequestRecord[]>;
  /**
   * Conditionally decide a request: must only update rows still in
   * "pending" status and return null otherwise, so concurrent decisions
   * cannot overwrite each other.
   */
  updateDecision(
    requestId: string,
    fields: {
      status: "approved" | "denied";
      decided_by: string;
      decided_at: Date;
    },
  ): Promise<ContextRequestRecord | null>;
  generateId(): string;
  /** Best-effort: put the approved file into the session workspace. */
  materializeApprovedPath?(
    sessionId: string,
    path: string,
  ): Promise<{ materialized: boolean; reason?: string }>;
  /** Optional room lookup + event emission for the activity feed. */
  getSessionRoomId?(sessionId: string): Promise<string | null>;
  emitActivityEvent?(input: EmitActivityEventInput): Promise<unknown>;
}

export class ContextRequestError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_input"
      | "request_not_found"
      | "already_decided",
    readonly status: number,
  ) {
    super(message);
    this.name = "ContextRequestError";
  }
}

const REQUEST_TYPES: readonly ContextRequestType[] = [
  "read_file",
  "search",
  "directory_listing",
  "command_output",
];

const MAX_REASON_LENGTH = 500;

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * File a context access request. Idempotent per (session, path): a repeat
 * ask while one is still pending returns the existing pending row, and a
 * repeat ask for an already-approved path retries materialization (the
 * recovery path when approval happened before the workspace existed).
 */
export async function createContextRequest(
  deps: ContextRequestsDeps,
  input: CreateContextRequestInput,
): Promise<ContextRequestRecord> {
  const normalizedPath = normalizeRequestPath(input.path);
  if (!normalizedPath) {
    throw new ContextRequestError(
      `invalid path: "${input.path}" — must be repo-relative`,
      "invalid_input",
      400,
    );
  }
  const requestType = input.requestType ?? "read_file";
  if (!REQUEST_TYPES.includes(requestType)) {
    throw new ContextRequestError(
      `invalid request_type: "${requestType}"`,
      "invalid_input",
      400,
    );
  }

  const existing = await deps.findPendingByPath(input.sessionId, normalizedPath);
  if (existing) return existing;

  const approved = await deps.findApprovedByPath?.(input.sessionId, normalizedPath);
  if (approved) {
    // Already approved — no new renter decision needed; just retry the
    // delivery in case the workspace was unavailable at approval time.
    await tryMaterialize(deps, input.sessionId, approved.path);
    return approved;
  }

  const now = new Date();
  let record: ContextRequestRecord;
  try {
    record = await deps.insert({
      id: deps.generateId(),
      session_id: input.sessionId,
      path: normalizedPath,
      request_type: requestType,
      status: "pending",
      reason: input.reason?.trim().slice(0, MAX_REASON_LENGTH) || null,
      requested_by: input.requestedBy ?? null,
      decided_by: null,
      decided_at: null,
      created_at: now,
      updated_at: now,
    });
  } catch (err) {
    // A concurrent create for the same (session, path) may have won the
    // unique pending index; the loser resolves to the winner's row.
    const winner = await deps.findPendingByPath(input.sessionId, normalizedPath);
    if (winner) return winner;
    throw err;
  }

  await emitEvent(deps, input.sessionId, {
    eventType: CONTEXT_ACCESS_REQUESTED,
    source: "provider",
    payload: {
      request_id: record.id,
      path: record.path,
      reason: record.reason,
    },
  });

  return record;
}

export async function listContextRequests(
  deps: ContextRequestsDeps,
  sessionId: string,
): Promise<ContextRequestRecord[]> {
  return deps.list(sessionId);
}

/**
 * Approve or deny a pending request. Re-deciding with the same decision
 * is idempotent; flipping an already-decided request is a 409.
 */
export async function decideContextRequest(
  deps: ContextRequestsDeps,
  input: DecideContextRequestInput,
): Promise<DecideContextRequestResult> {
  const request = await deps.getById(input.sessionId, input.requestId);
  if (!request) {
    throw new ContextRequestError(
      "context request not found",
      "request_not_found",
      404,
    );
  }

  if (request.status !== "pending") {
    if (request.status === input.decision) {
      // Idempotent re-decide. For approvals, retry delivery so an
      // approval that predated the workspace can still land the file.
      if (input.decision === "approved") {
        const retry = await tryMaterialize(deps, input.sessionId, request.path);
        return {
          request,
          materialized: retry.materialized,
          materializeReason: retry.reason,
        };
      }
      return { request, materialized: false, materializeReason: "already_decided" };
    }
    throw new ContextRequestError(
      `request already ${request.status}`,
      "already_decided",
      409,
    );
  }

  const updated = await deps.updateDecision(request.id, {
    status: input.decision,
    decided_by: input.decidedBy,
    decided_at: new Date(),
  });
  if (!updated) {
    // updateDecision is conditional on status = pending; a concurrent
    // decision won. Re-read and apply the idempotency rules.
    const current = await deps.getById(input.sessionId, input.requestId);
    if (current && current.status === input.decision) {
      return { request: current, materialized: false, materializeReason: "already_decided" };
    }
    if (current) {
      throw new ContextRequestError(
        `request already ${current.status}`,
        "already_decided",
        409,
      );
    }
    throw new ContextRequestError(
      "context request not found",
      "request_not_found",
      404,
    );
  }

  let materialized = false;
  let materializeReason: string | undefined;
  if (input.decision === "approved") {
    const result = await tryMaterialize(deps, input.sessionId, updated.path);
    materialized = result.materialized;
    materializeReason = result.reason;
  }

  await emitEvent(deps, input.sessionId, {
    eventType:
      input.decision === "approved"
        ? CONTEXT_ACCESS_APPROVED
        : CONTEXT_ACCESS_DENIED,
    source: "renter",
    payload: {
      request_id: updated.id,
      path: updated.path,
      materialized,
      ...(materializeReason ? { materialize_reason: materializeReason } : {}),
    },
  });

  return { request: updated, materialized, materializeReason };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Best-effort delivery of an approved path; never throws. */
async function tryMaterialize(
  deps: ContextRequestsDeps,
  sessionId: string,
  path: string,
): Promise<{ materialized: boolean; reason?: string }> {
  if (!deps.materializeApprovedPath) {
    return { materialized: false, reason: "materializer_unavailable" };
  }
  try {
    return await deps.materializeApprovedPath(sessionId, path);
  } catch (err) {
    return {
      materialized: false,
      reason: err instanceof Error ? err.message : "materialize_failed",
    };
  }
}

async function emitEvent(
  deps: ContextRequestsDeps,
  sessionId: string,
  event: {
    eventType:
      | typeof CONTEXT_ACCESS_REQUESTED
      | typeof CONTEXT_ACCESS_APPROVED
      | typeof CONTEXT_ACCESS_DENIED;
    source: "provider" | "renter";
    payload: Record<string, unknown>;
  },
): Promise<void> {
  if (!deps.emitActivityEvent || !deps.getSessionRoomId) return;
  const roomId = await deps.getSessionRoomId(sessionId);
  if (!roomId) return;
  await deps.emitActivityEvent({
    sessionId,
    roomId,
    eventType: event.eventType,
    source: event.source,
    payload: event.payload,
  });
}

/** Same repo-relative normalization rules as the Context Broker. */
export function normalizeRequestPath(filePath: string): string | null {
  if (typeof filePath !== "string" || filePath.includes("\0")) return null;
  const normalized = filePath.trim().replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    return null;
  }
  const resolved: string[] = [];
  for (const segment of normalized.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (resolved.length === 0) return null;
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  return resolved.length ? resolved.join("/") : null;
}

// ---------------------------------------------------------------------------
// Default (drizzle-backed) deps
// ---------------------------------------------------------------------------

export function createDefaultContextRequestsDeps(): ContextRequestsDeps {
  return {
    async findPendingByPath(sessionId, filePath) {
      const { db } = await import("../db/client.js");
      const { rental_context_requests } = await import("../db/schema.js");
      const [row] = await db
        .select()
        .from(rental_context_requests)
        .where(
          and(
            eq(rental_context_requests.session_id, sessionId),
            eq(rental_context_requests.path, filePath),
            eq(rental_context_requests.status, "pending"),
          ),
        );
      return (row as ContextRequestRecord | undefined) ?? null;
    },
    async findApprovedByPath(sessionId, filePath) {
      const { db } = await import("../db/client.js");
      const { rental_context_requests } = await import("../db/schema.js");
      const [row] = await db
        .select()
        .from(rental_context_requests)
        .where(
          and(
            eq(rental_context_requests.session_id, sessionId),
            eq(rental_context_requests.path, filePath),
            eq(rental_context_requests.status, "approved"),
          ),
        )
        .orderBy(desc(rental_context_requests.decided_at))
        .limit(1);
      return (row as ContextRequestRecord | undefined) ?? null;
    },
    async getById(sessionId, requestId) {
      const { db } = await import("../db/client.js");
      const { rental_context_requests } = await import("../db/schema.js");
      const [row] = await db
        .select()
        .from(rental_context_requests)
        .where(
          and(
            eq(rental_context_requests.id, requestId),
            eq(rental_context_requests.session_id, sessionId),
          ),
        );
      return (row as ContextRequestRecord | undefined) ?? null;
    },
    async insert(record) {
      const { db } = await import("../db/client.js");
      const { rental_context_requests } = await import("../db/schema.js");
      const [row] = await db
        .insert(rental_context_requests)
        .values(record)
        .returning();
      return row as ContextRequestRecord;
    },
    async list(sessionId) {
      const { db } = await import("../db/client.js");
      const { rental_context_requests } = await import("../db/schema.js");
      const rows = await db
        .select()
        .from(rental_context_requests)
        .where(eq(rental_context_requests.session_id, sessionId))
        .orderBy(desc(rental_context_requests.created_at));
      return rows as ContextRequestRecord[];
    },
    async updateDecision(requestId, fields) {
      const { db } = await import("../db/client.js");
      const { rental_context_requests } = await import("../db/schema.js");
      const [row] = await db
        .update(rental_context_requests)
        .set({ ...fields, updated_at: new Date() })
        .where(
          and(
            eq(rental_context_requests.id, requestId),
            eq(rental_context_requests.status, "pending"),
          ),
        )
        .returning();
      return (row as ContextRequestRecord | undefined) ?? null;
    },
    generateId: () => `rctxr_${randomUUID().replace(/-/g, "")}`,
    async materializeApprovedPath(sessionId, filePath) {
      const { db } = await import("../db/client.js");
      const { rental_sessions, rental_workspace_manifests } = await import(
        "../db/schema.js"
      );
      const { materializeApprovedFile } = await import(
        "./workspace-materializer.js"
      );

      const [manifest] = await db
        .select()
        .from(rental_workspace_manifests)
        .where(
          and(
            eq(rental_workspace_manifests.session_id, sessionId),
            eq(rental_workspace_manifests.retention_status, "active"),
          ),
        );
      if (!manifest) {
        return { materialized: false, reason: "workspace_unavailable" };
      }

      const [session] = await db
        .select()
        .from(rental_sessions)
        .where(eq(rental_sessions.id, sessionId));
      if (!session || session.repo_provider !== "github") {
        return { materialized: false, reason: "repo_unavailable" };
      }

      const repoUrl = `https://github.com/${session.repo_owner}/${session.repo_name}.git`;
      return materializeApprovedFile({
        manifest: {
          session_id: manifest.session_id,
          base_commit_sha: manifest.base_commit_sha,
          workspace_path: manifest.workspace_path,
        },
        repoUrl,
        filePath,
      });
    },
    async getSessionRoomId(sessionId) {
      const { db } = await import("../db/client.js");
      const { rental_sessions } = await import("../db/schema.js");
      const [session] = await db
        .select()
        .from(rental_sessions)
        .where(eq(rental_sessions.id, sessionId));
      return session?.room_id ?? null;
    },
    async emitActivityEvent(input) {
      const { emitActivityEvent } = await import("./activity-emitter.js");
      return emitActivityEvent(input);
    },
  };
}
