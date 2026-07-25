import type { Express, Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "../../../db/client.js";
import { message_agent_receipts, message_agent_receipt_events, messages } from "../../../db/schema.js";
import { parseScopedId } from "../../../db/utils.js";
import { resolveParticipantRoom, routeParam } from "./helpers.js";
import { requireWorkerRequestAgentIdentity } from "../../../request/agent-identity.js";
import { queueMessageInfoInvalidation } from "../../../server/message-info-events.js";
import type { AuthenticatedRequest } from "../../../http/helpers.js";
import type { RoomMessageRouteDeps } from "./types.js";

export function registerAgentReceiptsRoute(
  app: Express,
  deps: RoomMessageRouteDeps
): void {
  app.put(/^\/rooms\/(.+)\/messages\/(msg_\d+)\/agent-receipts\/self$/, async (req: AuthenticatedRequest, res: Response) => {
    const project = await resolveParticipantRoom(req, res, deps);
    if (!project) return;

    const workerIdentity = await requireWorkerRequestAgentIdentity({
      req,
      body: req.body || {},
      room_id: project.id,
    });

    if (!workerIdentity.ok) {
      res.status(workerIdentity.status).json({ error: workerIdentity.error });
      return;
    }

    const { identity } = workerIdentity;
    const agentSessionId = identity.agent_session_id;
    if (!agentSessionId) {
      res.status(400).json({ error: "Worker session required" });
      return;
    }

    const rawMessageId = routeParam(req, 1);
    const messageNumber = parseScopedId(rawMessageId, "msg");
    if (!messageNumber) {
      res.status(404).json({ error: "message does not exist in this room" });
      return;
    }

    const { receipt_state } = req.body || {};
    if (!receipt_state) {
      res.status(400).json({ error: "Missing required receipt_state parameter" });
      return;
    }

    // "unavailable" and "replied" are deliberately absent: unavailable is the
    // server-owned terminal session transition, and replied is derived
    // atomically from a committed reply message at creation time. An agent
    // must never be able to claim a reply that does not exist as a message.
    const validStates = [
      "queued",
      "responding",
      "no_reply",
      "retrying",
      "blocked",
      "cancelled",
    ];

    if (!validStates.includes(receipt_state)) {
      res.status(400).json({ error: "Invalid receipt_state" });
      return;
    }
    const requestedState = receipt_state as string;

    const timestamp = new Date().toISOString();

    // Receipts are seeded against the send-time session. Match the durable
    // agent_key so a rotated successor session can advance its own receipt.
    const [existingReceipt] = await db
      .select()
      .from(message_agent_receipts)
      .where(
        and(
          eq(message_agent_receipts.message_room_id, project.id),
          eq(message_agent_receipts.message_number, messageNumber),
          eq(message_agent_receipts.agent_key, identity.agent_key)
        )
      )
      .limit(1);

    if (!existingReceipt) {
      res.status(404).json({ error: "No send-time routing receipt exists for this agent" });
      return;
    }

    const fromState = existingReceipt.receipt_state;
    if (fromState === requestedState) {
      // Idempotent replay: no state change, no duplicate history event.
      res.json({
        success: true,
        receipt_id: existingReceipt.id,
        receipt_state: requestedState,
      });
      return;
    }

    if (!canTransitionReceiptState(fromState, requestedState)) {
      res.status(409).json({
        error: `Receipt state cannot move from '${fromState}' to '${requestedState}'.`,
        receipt_state: fromState,
      });
      return;
    }

    // Compare-and-set against the observed state, with the history event in
    // the same transaction: a racing writer loses cleanly instead of silently
    // regressing the receipt or splitting state from its event.
    const applied = await db.transaction(async (tx) => {
      const updated = await tx
        .update(message_agent_receipts)
        .set({
          receipt_state: requestedState,
          actor_label: identity.actor_label,
          updated_at: timestamp,
        })
        .where(and(
          eq(message_agent_receipts.id, existingReceipt.id),
          eq(message_agent_receipts.receipt_state, fromState),
        ))
        .returning({ id: message_agent_receipts.id });
      if (updated.length === 0) return false;

      await tx.insert(message_agent_receipt_events).values({
        id: `rcpt_evt_${randomUUID().replace(/-/g, "")}`,
        receipt_id: existingReceipt.id,
        message_room_id: project.id,
        message_number: messageNumber,
        from_state: fromState,
        to_state: requestedState,
        actor_session_id: agentSessionId,
        timestamp,
      });
      return true;
    });

    if (!applied) {
      res.status(409).json({ error: "Receipt state changed concurrently; re-read and retry." });
      return;
    }

    // Room-level: naming the exact id would reveal receipt activity on
    // messages the info endpoint conceals from some participants.
    queueMessageInfoInvalidation(project.id, null);
    res.json({
      success: true,
      receipt_id: existingReceipt.id,
      receipt_state: requestedState,
    });
  });
}

/**
 * Receipt lifecycle graph. `replied` and `cancelled` are terminal, with two
 * deliberate exceptions: a late reply upgrades `no_reply`, and a successor
 * session may revive a server-marked `unavailable` receipt. `unavailable` has
 * no self-reported entry edge — only the session lifecycle writes it.
 */
const RECEIPT_STATE_TRANSITIONS: Record<string, readonly string[]> = {
  queued: ["responding", "retrying", "blocked", "no_reply", "replied", "cancelled"],
  responding: ["retrying", "blocked", "no_reply", "replied", "cancelled"],
  retrying: ["responding", "blocked", "no_reply", "replied", "cancelled"],
  blocked: ["responding", "retrying", "no_reply", "replied", "cancelled"],
  no_reply: ["replied"],
  unavailable: ["responding", "replied"],
  replied: [],
  cancelled: [],
};

export function canTransitionReceiptState(from: string, to: string): boolean {
  return (RECEIPT_STATE_TRANSITIONS[from] ?? []).includes(to);
}
