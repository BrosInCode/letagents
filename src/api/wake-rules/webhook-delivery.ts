/**
 * What a wake webhook sends and when. Pure functions: the payload and its
 * signature, the coalescing and hourly-cap plan for a new match, and the
 * failure count that pauses a rule. The database and the network are in
 * `webhook-enqueue.ts` and `../notifications/wake-webhooks.ts`.
 */
import { createHmac } from "node:crypto";

import { WAKE_RULE_LIMITS } from "../../../shared/wake-rules.mjs";
import type { CredentialBinding } from "../connectors/crypto.js";
import { WAKE_WEBHOOK_MAX_BODY_BYTES } from "./webhook-url.js";

export const WAKE_WEBHOOK_SENDER_MAX = 120;

/** What a sealed webhook target is bound to: it decrypts only on its own rule, for its own account. */
export function wakeWebhookBinding(ruleId: string, ownerAccountId: string): CredentialBinding {
  return { connection_id: `wake_webhook:${ruleId}`, account_id: ownerAccountId };
}

const HOUR_MS = 60 * 60 * 1000;

/** One line of plain text, cut to `max` characters (code points), with an ellipsis when cut. */
export function oneLine(value: string | null | undefined, max: number): string {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  const points = Array.from(text);
  return points.length > max ? `${points.slice(0, max - 1).join("")}…` : text;
}

export function wakeWebhookTextPreview(text: string | null | undefined): string {
  return oneLine(text, WAKE_RULE_LIMITS.webhookTextPreviewMax);
}

/** The room's page in the web app. */
export function wakeWebhookRoomUrl(roomId: string, baseUrl = publicBaseUrl()): string {
  return `${baseUrl.replace(/\/+$/, "")}/in/${roomId.split("/").map(encodeURIComponent).join("/")}`;
}

function publicBaseUrl(): string {
  return process.env.LETAGENTS_PUBLIC_URL ?? process.env.LETAGENTS_BASE_URL ?? "https://letagents.chat";
}

export interface WakeWebhookPayload {
  /** The same for every attempt of one delivery, so a receiver can ignore a retry it already handled. */
  delivery_id: string;
  room_id: string;
  message_id: string;
  sender: string;
  text_preview: string;
  room_url: string;
  rule_id: string;
  sent_at: string;
}

/**
 * The exact request body. The preview (then the sender) is shortened until
 * the body fits in 4 KB, so the signature always covers what is sent.
 */
export function buildWakeWebhookBody(payload: WakeWebhookPayload): string {
  let preview = Array.from(payload.text_preview);
  let sender = Array.from(payload.sender);
  for (;;) {
    const body = JSON.stringify({ ...payload, sender: sender.join(""), text_preview: preview.join("") });
    if (Buffer.byteLength(body, "utf8") <= WAKE_WEBHOOK_MAX_BODY_BYTES) return body;
    if (preview.length > 0) preview = preview.slice(0, Math.max(0, preview.length - 32));
    else if (sender.length > 0) sender = sender.slice(0, Math.max(0, sender.length - 32));
    else throw new Error("Wake webhook payload cannot fit in 4 KB.");
  }
}

/** `sha256=` and the hex HMAC-SHA256 of `<timestamp>.<raw body>` under the rule's secret. */
export function signWakeWebhook(secret: string, timestamp: number, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex")}`;
}

export function wakeWebhookHeaders(input: { deliveryId: string; timestamp: number; signature: string }): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "User-Agent": "LetAgents-Wake-Webhook/1",
    "X-LetAgents-Delivery": input.deliveryId,
    "X-LetAgents-Timestamp": String(input.timestamp),
    "X-LetAgents-Signature": input.signature,
  };
}

/** What the rule's deliveries look like when a new match arrives. */
export interface WakeWebhookEnqueueState {
  nowMs: number;
  /** A delivery that is queued and not yet attempted; a new match folds into it. */
  pendingDeliveryId: string | null;
  /** When the rule's newest delivery was (or is) due to go out. */
  lastScheduledAtMs: number | null;
  /** Deliveries the rule started in the past hour. */
  startedInLastHour: number;
}

export type WakeWebhookEnqueuePlan =
  | { kind: "coalesce"; deliveryId: string }
  | { kind: "drop" }
  | { kind: "insert"; scheduledAtMs: number };

/**
 * At most one delivery per rule in each 10-second window. The first match
 * after a quiet window goes out at once; matches inside the window fold into
 * one delivery that goes out when the window ends and carries the newest
 * message. Beyond 20 deliveries an hour a match is dropped (and counted),
 * unless it can fold into a delivery that is already waiting.
 */
export function planWakeWebhookEnqueue(state: WakeWebhookEnqueueState): WakeWebhookEnqueuePlan {
  if (state.pendingDeliveryId) return { kind: "coalesce", deliveryId: state.pendingDeliveryId };
  if (state.startedInLastHour >= WAKE_RULE_LIMITS.webhookHourlyCap) return { kind: "drop" };
  const windowEndMs = state.lastScheduledAtMs === null
    ? state.nowMs
    : state.lastScheduledAtMs + WAKE_RULE_LIMITS.webhookCoalesceMs;
  return { kind: "insert", scheduledAtMs: Math.max(state.nowMs, windowEndMs) };
}

export const WAKE_WEBHOOK_HOUR_MS = HOUR_MS;

/** After a delivery failed for good: the new run of failures, and whether the rule pauses now. */
export function afterFinalWakeWebhookFailure(consecutiveFailures: number): { consecutiveFailures: number; pause: boolean } {
  const next = consecutiveFailures + 1;
  return { consecutiveFailures: next, pause: next >= WAKE_RULE_LIMITS.webhookPauseAfterFailures };
}
