/**
 * Email as a wake delivery kind: SMTP through the small client in `smtp.ts`,
 * configured only by `LETAGENTS_EMAIL_SMTP_URL` and `LETAGENTS_EMAIL_FROM`.
 * The SMTP URL holds a password and is never logged. An address must confirm
 * before anything but a confirmation is sent to it, and every email carries a
 * stop link.
 */
import { createHash } from "node:crypto";

import type { ConnectorCipher } from "../connectors/crypto.js";
import { parseSmtpUrl, sendSmtpMail, SmtpError, type SmtpConfig, type SmtpSendOptions } from "./smtp.js";
import { oneLine } from "./webhook-delivery.js";
import type { WakeDeliveryErrorClass } from "./webhook-url.js";

export { wakeLinkUrl } from "./public-url.js";

export const EMAIL_SMTP_URL_ENV = "LETAGENTS_EMAIL_SMTP_URL";
export const EMAIL_FROM_ENV = "LETAGENTS_EMAIL_FROM";
export const EMAIL_NOT_CONFIGURED = "Email delivery is not configured on this server.";

export function wakeEmailConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[EMAIL_SMTP_URL_ENV]?.trim() && env[EMAIL_FROM_ENV]?.trim());
}

export interface WakeEmailMessage {
  to: string;
  subject: string;
  text: string;
  headers: Record<string, string>;
}

export interface WakeMailResult {
  outcome: "delivered" | "retry" | "dead";
  /** The SMTP reply code, 250 when accepted, 0 when none arrived. */
  status: number;
  error: WakeDeliveryErrorClass | null;
  /**
   * The failure is on the server's side (its SMTP account, its connection, its
   * TLS), not the rule's: it is retried and never pauses a rule.
   */
  operator?: boolean;
}

export interface WakeMailer {
  send(message: WakeEmailMessage): Promise<WakeMailResult>;
}

let lastOperatorLogMs = 0;

/** Tell the operator once a minute at most; never the URL or the server's text. */
function logOperatorProblem(error: unknown): void {
  const nowMs = Date.now();
  if (nowMs - lastOperatorLogMs < 60_000) return;
  lastOperatorLogMs = nowMs;
  const detail = error instanceof SmtpError ? `${error.stage}${error.code ? ` ${error.code}` : ""}` : "connection";
  console.error(`[wake email] operator problem: SMTP ${detail}. Check ${EMAIL_SMTP_URL_ENV} and the mail provider; emails wait and retry.`);
}

/**
 * Only a reply to RCPT TO or DATA is about the recipient: a permanent one
 * (5xx) is final and counts against the rule, a temporary one (4xx) retries.
 * Anything earlier (connect, TLS, EHLO, AUTH, MAIL FROM) is the operator's
 * problem: it retries, never pauses a rule, and is logged.
 */
export function classifyWakeMailError(error: unknown): WakeMailResult {
  if (error instanceof SmtpError && (error.stage === "rcpt" || error.stage === "data") && error.code >= 400) {
    return error.code >= 500
      ? { outcome: "dead", status: error.code, error: "smtp_rejected" }
      : { outcome: "retry", status: error.code, error: "smtp_deferred" };
  }
  logOperatorProblem(error);
  return { outcome: "retry", status: error instanceof SmtpError ? error.code : 0, error: "smtp_operator", operator: true };
}

export function createSmtpMailer(config: SmtpConfig, from: string, options: SmtpSendOptions = {}): WakeMailer {
  return {
    async send(message) {
      try {
        await sendSmtpMail(config, { from, to: message.to, subject: message.subject, text: message.text, headers: message.headers }, options);
        return { outcome: "delivered", status: 250, error: null };
      } catch (error) {
        return classifyWakeMailError(error);
      }
    },
  };
}

/** The server's mailer, or null when email is not configured (or its URL is unusable). */
export function loadWakeMailer(env: NodeJS.ProcessEnv = process.env): WakeMailer | null {
  const url = env[EMAIL_SMTP_URL_ENV]?.trim();
  const from = env[EMAIL_FROM_ENV]?.trim();
  if (!url || !from) return null;
  try {
    return createSmtpMailer(parseSmtpUrl(url), from);
  } catch {
    // The URL carries a password: say which setting is wrong, never its value.
    console.error(`[wake email] ${EMAIL_SMTP_URL_ENV} is not an smtp:// or smtps:// URL; email delivery is off.`);
    return null;
  }
}

/**
 * Link tokens are HMACs under the connector key, so only the server can make
 * one; the database keeps only their SHA-256. The stop link of a rule never
 * changes (old emails keep working); each confirmation has its own.
 */
export function wakeEmailDisableToken(cipher: ConnectorCipher, ruleId: string): string {
  return cipher.fingerprint("wake-email-disable", ruleId);
}

export function wakeEmailConfirmToken(cipher: ConnectorCipher, ruleId: string, confirmExpiresAt: string): string {
  return cipher.fingerprint("wake-email-confirm", `${ruleId}:${new Date(confirmExpiresAt).toISOString()}`);
}

/**
 * The mailbox an address reaches, for counting only: lower case, no "+tag",
 * and for Gmail no dots and googlemail.com read as gmail.com. So
 * `V.ictim+1@googlemail.com` and `victim@gmail.com` share one daily budget and
 * one Stop. The sealed address is kept exactly as written.
 */
export function wakeEmailMailboxKey(address: string): string {
  const lower = address.trim().toLowerCase();
  const at = lower.lastIndexOf("@");
  if (at <= 0) return lower;
  let local = lower.slice(0, at);
  let domain = lower.slice(at + 1);
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return `${local}@${domain}`;
}

/** The keyed fingerprint of an address's mailbox: confirmations are counted and stops remembered by it. */
export function wakeEmailAddressFingerprint(cipher: ConnectorCipher, address: string): string {
  return cipher.fingerprint("wake-email-to", wakeEmailMailboxKey(address));
}

export function hashWakeLinkToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export const WAKE_LINK_TOKEN = /^[0-9a-f]{64}$/;

export interface WakeEmailInput {
  purpose: "message" | "confirm";
  to: string;
  roomUrl: string;
  disableUrl: string;
  /** purpose "confirm" */
  confirmUrl?: string;
  /** purpose "message" */
  agentName?: string;
  roomName?: string;
  sender?: string;
  preview?: string;
  messageId?: string;
  deliveryId?: string;
}

/**
 * Plain-text email with a stop link in the body and in List-Unsubscribe
 * (RFC 2369, one-click per RFC 8058). A confirmation is fixed wording: the
 * agent and the room chose their own names, so none of their text goes to an
 * address that has not agreed to anything yet. Only the room link does.
 */
export function composeWakeEmail(input: WakeEmailInput): WakeEmailMessage {
  const headers: Record<string, string> = {
    "Auto-Submitted": "auto-generated",
    "List-Unsubscribe": `<${input.disableUrl}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    ...(input.deliveryId ? { "X-LetAgents-Delivery": input.deliveryId } : {}),
  };
  if (input.purpose === "confirm") {
    return {
      to: input.to,
      subject: "[LetAgents] Confirm email notifications",
      headers,
      text: [
        "An agent in a LetAgents room asked to email this address when a message in the room is for it.",
        "",
        `The room: ${input.roomUrl}`,
        "",
        `To allow these emails, open this link and press Confirm (it works for 24 hours): ${input.confirmUrl}`,
        "",
        "If you did not expect this email, ignore it: nothing else is sent unless you confirm.",
        `To refuse further requests for this address: ${input.disableUrl}`,
      ].join("\n"),
    };
  }
  const agent = oneLine(input.agentName, 80) || "your agent";
  const room = oneLine(input.roomName, 80) || "a room";
  return {
    to: input.to,
    subject: `[LetAgents] New message for ${agent} in ${room}`,
    headers,
    text: [
      `From: ${oneLine(input.sender, 120)}`,
      `Message: ${input.messageId}`,
      "",
      oneLine(input.preview, 200),
      "",
      `Open the room: ${input.roomUrl}`,
      "",
      `LetAgents sends this because ${agent} asked to be emailed at this address when a message in ${room} is for it, and the address confirmed it.`,
      `Stop these emails: ${input.disableUrl}`,
    ].join("\n"),
  };
}
