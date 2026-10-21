import { createHmac, timingSafeEqual } from "node:crypto";

import { asRecord, asString } from "./http.js";
import type { ExternalItemChange, WebhookRequest, WebhookVerification } from "./types.js";

const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d{1,12}$/;
/** Linear signs `webhookTimestamp`; an older delivery is refused as a replay. */
const LINEAR_MAX_AGE_MS = 5 * 60_000;

function header(headers: WebhookRequest["headers"], name: string): string | null {
  const value = headers[name.toLowerCase()] ?? headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" && first.trim() ? first.trim() : null;
}

function hmacHex(secret: string, body: Buffer): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function sameHex(expected: string, given: string | null): boolean {
  if (!given || !/^[0-9a-f]+$/i.test(given)) return false;
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(given.toLowerCase(), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

const REFUSED: WebhookVerification = { ok: false, deliveryId: "" };

/**
 * Jira Cloud webhooks registered with a secret send
 * `X-Hub-Signature: sha256=<hex HMAC of the body>`. The delivery id is
 * `X-Atlassian-Webhook-Identifier`, else the signature itself.
 */
export function verifyJiraWebhook(req: WebhookRequest): WebhookVerification {
  if (!req.secret) return REFUSED;
  const signature = header(req.headers, "x-hub-signature");
  const match = signature ? /^sha256=([0-9a-f]{64})$/i.exec(signature) : null;
  if (!match || !sameHex(hmacHex(req.secret, req.rawBody), match[1])) return REFUSED;
  return { ok: true, deliveryId: header(req.headers, "x-atlassian-webhook-identifier") ?? `sig:${match[1].toLowerCase()}` };
}

/** `jira:issue_created|updated|deleted` events name one issue key. */
export function parseJiraWebhook(payload: unknown): ExternalItemChange[] {
  const record = asRecord(payload);
  const event = asString(record.webhookEvent) ?? "";
  if (!event.startsWith("jira:issue_")) return [];
  const key = asString(asRecord(record.issue).key)?.toUpperCase();
  if (!key || !ISSUE_KEY.test(key)) return [];
  return [{ key, item: null, deleted: event === "jira:issue_deleted" }];
}

/**
 * Linear sends `Linear-Signature: <hex HMAC of the body>` and the delivery id
 * in `Linear-Delivery`. The body's `webhookTimestamp` must be recent.
 */
export function verifyLinearWebhook(req: WebhookRequest): WebhookVerification {
  if (!req.secret) return REFUSED;
  if (!sameHex(hmacHex(req.secret, req.rawBody), header(req.headers, "linear-signature"))) return REFUSED;
  let timestamp = Number.NaN;
  try {
    timestamp = Number(asRecord(JSON.parse(req.rawBody.toString("utf8"))).webhookTimestamp);
  } catch {
    return REFUSED;
  }
  const now = (req.now ?? new Date()).getTime();
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > LINEAR_MAX_AGE_MS) return REFUSED;
  return { ok: true, deliveryId: header(req.headers, "linear-delivery") ?? `ts:${timestamp}` };
}

/** `Issue` create, update and remove events name one issue identifier. */
export function parseLinearWebhook(payload: unknown): ExternalItemChange[] {
  const record = asRecord(payload);
  if (record.type !== "Issue") return [];
  const key = asString(asRecord(record.data).identifier)?.toUpperCase();
  if (!key || !ISSUE_KEY.test(key)) return [];
  return [{ key, item: null, deleted: record.action === "remove" }];
}
