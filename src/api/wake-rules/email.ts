/**
 * Email as a wake delivery kind: SMTP through nodemailer, configured only by
 * `LETAGENTS_EMAIL_SMTP_URL` and `LETAGENTS_EMAIL_FROM`. The SMTP URL holds a
 * password and is never logged. An address must confirm before anything but
 * the confirmation is sent to it, and every email carries a stop link.
 */
import { createHash } from "node:crypto";
import nodemailer from "nodemailer";

import type { ConnectorCipher } from "../connectors/crypto.js";
import { oneLine } from "./webhook-delivery.js";

export const EMAIL_SMTP_URL_ENV = "LETAGENTS_EMAIL_SMTP_URL";
export const EMAIL_FROM_ENV = "LETAGENTS_EMAIL_FROM";
export const EMAIL_NOT_CONFIGURED = "Email delivery is not configured on this server.";

const SMTP_TIMEOUTS = { connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 };

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
  error: string | null;
}

export interface WakeMailer {
  send(message: WakeEmailMessage): Promise<WakeMailResult>;
}

/** Anything with nodemailer's `sendMail`: an SMTP transport, or a json/stream transport in tests. */
export interface MailTransport {
  sendMail(options: Record<string, unknown>): Promise<unknown>;
}

/**
 * A permanent SMTP rejection (5xx) is final; a temporary one (4xx), a
 * connection error or a timeout is retried. A message nodemailer cannot even
 * build (a bad envelope) is final too.
 */
export function classifyWakeMailError(error: unknown): WakeMailResult {
  const failure = error as { responseCode?: unknown; code?: unknown; message?: unknown } | null;
  const code = typeof failure?.responseCode === "number" ? failure.responseCode : 0;
  const text = oneLine(typeof failure?.message === "string" ? failure.message : String(error), 300) || "Email could not be sent.";
  if (code >= 500) return { outcome: "dead", status: code, error: text };
  if (code >= 400) return { outcome: "retry", status: code, error: text };
  if (failure?.code === "EENVELOPE" || failure?.code === "EMESSAGE") return { outcome: "dead", status: 0, error: text };
  return { outcome: "retry", status: 0, error: text };
}

export function createWakeMailer(transport: MailTransport, from: string): WakeMailer {
  return {
    async send(message) {
      try {
        await transport.sendMail({ from, to: message.to, subject: message.subject, text: message.text, headers: message.headers });
        return { outcome: "delivered", status: 250, error: null };
      } catch (error) {
        return classifyWakeMailError(error);
      }
    },
  };
}

let cached: { key: string; mailer: WakeMailer | null } | null = null;

/** The server's mailer, or null when email is not configured (or its URL is unusable). */
export function loadWakeMailer(env: NodeJS.ProcessEnv = process.env): WakeMailer | null {
  const url = env[EMAIL_SMTP_URL_ENV]?.trim();
  const from = env[EMAIL_FROM_ENV]?.trim();
  if (!url || !from) return null;
  const key = createHash("sha256").update(`${url}\u0000${from}`).digest("hex");
  if (cached?.key === key) return cached.mailer;
  let mailer: WakeMailer | null = null;
  try {
    mailer = createWakeMailer(nodemailer.createTransport({ url, ...SMTP_TIMEOUTS }) as unknown as MailTransport, from);
  } catch {
    // The URL carries a password: say which setting is wrong, never its value.
    console.error(`[wake email] ${EMAIL_SMTP_URL_ENV} is not a usable SMTP URL; email delivery is off.`);
  }
  cached = { key, mailer };
  return mailer;
}

/** The API's public origin, where the confirmation and stop links are served. */
export function wakeLinkBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.LETAGENTS_BASE_URL ?? env.PUBLIC_API_URL ?? "https://letagents.chat").replace(/\/+$/, "");
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

export function hashWakeLinkToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export const WAKE_LINK_TOKEN = /^[0-9a-f]{64}$/;

export function wakeLinkUrl(kind: "confirm" | "disable", token: string, baseUrl = wakeLinkBaseUrl()): string {
  return `${baseUrl.replace(/\/+$/, "")}/wake-rules/${kind}/${token}`;
}

export interface WakeEmailInput {
  purpose: "message" | "confirm";
  to: string;
  agentName: string;
  roomName: string;
  roomUrl: string;
  disableUrl: string;
  /** purpose "confirm" */
  confirmUrl?: string;
  /** purpose "message" */
  sender?: string;
  preview?: string;
  messageId?: string;
  deliveryId?: string;
}

/** Plain-text email with a stop link in the body and in List-Unsubscribe (RFC 2369, one-click per RFC 8058). */
export function composeWakeEmail(input: WakeEmailInput): WakeEmailMessage {
  const agent = oneLine(input.agentName, 80) || "your agent";
  const room = oneLine(input.roomName, 80) || "a room";
  const headers: Record<string, string> = {
    "Auto-Submitted": "auto-generated",
    "List-Unsubscribe": `<${input.disableUrl}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    ...(input.deliveryId ? { "X-LetAgents-Delivery": input.deliveryId } : {}),
  };
  if (input.purpose === "confirm") {
    return {
      to: input.to,
      subject: `[LetAgents] Confirm email wake-ups for ${agent} in ${room}`,
      headers,
      text: [
        `The agent ${agent} asked LetAgents to email this address when a message in ${room} is for it.`,
        "",
        `Confirm within 24 hours: ${input.confirmUrl}`,
        "",
        "Until you confirm, nothing else is sent. If you did not expect this email, ignore it.",
        "",
        `Stop these emails: ${input.disableUrl}`,
      ].join("\n"),
    };
  }
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
