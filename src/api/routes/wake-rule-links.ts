/**
 * The links in a wake email. They are opened from a mail client, so they need
 * no sign-in: the token itself is the proof (an HMAC under the connector key;
 * the table keeps only its SHA-256).
 *
 * Mail security scanners open links on their own, so opening a link changes
 * nothing: a GET only shows a page whose button sends a POST. The stop link
 * also takes the one-click POST of a mail client (RFC 8058), whose body must
 * be exactly `List-Unsubscribe=One-Click`.
 */
import express, { type Express, type Request, type Response } from "express";

import { loadConnectorCipher } from "../connectors/crypto.js";
import {
  confirmWakeEmailRule,
  requestWakeEmailConfirmationAgain,
  stopWakeEmailRule,
  type WakeLinkOutcome,
} from "../db/wake-rules.js";
import { queueWakeRuleInvalidation } from "../server/events.js";
import { WAKE_LINK_TOKEN, hashWakeLinkToken, wakeEmailConfirmToken } from "../wake-rules/email.js";

const ONE_CLICK = "List-Unsubscribe=One-Click";
const CONFIRM = "confirm=yes";
const AGAIN = "again=yes";

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

/** A tiny page with fixed wording: nothing on it comes from an agent or a room. */
function page(res: Response, status: number, title: string, text: string, form?: { field: string; button: string; action?: string }): void {
  const [name, value] = form ? form.field.split("=") : [];
  const body = [
    "<!doctype html>",
    "<html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">",
    "<meta name=\"robots\" content=\"noindex\"><title>LetAgents</title>",
    "<style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#1c1c1c;background:#fff}",
    "button{font:inherit;padding:.5rem 1.1rem;cursor:pointer}</style></head><body>",
    `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p>`,
    form
      ? `<form method="post"${form.action ? ` action="${escapeHtml(form.action)}"` : ""}><input type="hidden" name="${escapeHtml(name!)}" value="${escapeHtml(value!)}"><button type="submit">${escapeHtml(form.button)}</button></form>`
      : "",
    "</body></html>",
  ].join("");
  res.status(status)
    .set({
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    })
    .type("text/html; charset=utf-8")
    .send(body);
}

function tokenOf(req: Request): string | null {
  const value = req.params.token;
  return typeof value === "string" && WAKE_LINK_TOKEN.test(value) ? value : null;
}

/** The raw form body, exactly as sent. */
const rawForm = express.text({ type: () => true, limit: "1kb" });
const bodyIs = (req: Request, expected: string) => typeof req.body === "string" && req.body === expected;

const INVALID = ["This link is not valid", "Check that the whole link was opened."] as const;

function answerFailure(res: Response, result: WakeLinkOutcome): void {
  switch (result.outcome) {
    case "expired":
      return page(res, 410, "This link has expired", "Ask the agent to add its email rule again for a new link.");
    case "conflict":
      return page(res, 409, "Already set up", "The agent already has the same email rule. Nothing changed.");
    case "limited":
      return page(res, 429, "Too many requests today", "This address already got the most confirmation requests allowed today. Try again tomorrow.");
    case "ended":
      return page(res, 410, "This email rule has ended", "Nothing more will be sent for it.");
    default:
      return page(res, 404, ...INVALID);
  }
}

async function guarded(res: Response, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error) {
    console.error("[wake email] link failed", error instanceof Error ? error.name : "error");
    page(res, 500, "Something went wrong", "Please open the link again.");
  }
}

export function registerWakeRuleLinkRoutes(app: Express): void {
  app.get("/wake-rules/confirm/:token", (req, res) => {
    if (!tokenOf(req)) return page(res, 404, ...INVALID);
    page(res, 200, "Confirm email notifications",
      "An agent in a LetAgents room asked to email this address when a message in the room is for it. Press Confirm to allow it.",
      { field: CONFIRM, button: "Confirm" });
  });

  app.post("/wake-rules/confirm/:token", rawForm, (req, res) => guarded(res, async () => {
    const token = tokenOf(req);
    if (!token) return page(res, 404, ...INVALID);
    if (!bodyIs(req, CONFIRM)) return page(res, 400, "Press the Confirm button", "Open the link from the email and press Confirm.");
    const result = await confirmWakeEmailRule(hashWakeLinkToken(token));
    if (result.outcome === "done") {
      queueWakeRuleInvalidation(result.rule.room_id);
      return page(res, 200, "Confirmed", "LetAgents will email this address when a message in the room is for the agent. Every email has a link to stop them.");
    }
    if (result.outcome === "already") return page(res, 200, "Already confirmed", "Nothing changed.");
    answerFailure(res, result);
  }));

  app.get("/wake-rules/disable/:token", (req, res) => {
    if (!tokenOf(req)) return page(res, 404, ...INVALID);
    page(res, 200, "Stop these emails",
      "Press Stop to stop LetAgents emails for this request. The address then gets no new requests until you ask for one.",
      { field: ONE_CLICK, button: "Stop" });
  });

  // The page's button and a mail client's one-click unsubscribe both land here.
  app.post("/wake-rules/disable/:token", rawForm, (req, res) => guarded(res, async () => {
    const token = tokenOf(req);
    if (!token) return page(res, 404, ...INVALID);
    if (!bodyIs(req, ONE_CLICK)) return page(res, 400, "Press the Stop button", "Open the link from the email and press Stop.");
    const result = await stopWakeEmailRule(hashWakeLinkToken(token));
    if (result.outcome === "done") queueWakeRuleInvalidation(result.rule.room_id);
    if (result.outcome === "done" || result.outcome === "already") {
      return page(res, 200, "Stopped",
        "LetAgents will not email this address for this request, and sends it no new requests. To allow requests again, press the button.",
        { field: AGAIN, button: "Allow a new request", action: `/wake-rules/disable/${token}/again` });
    }
    answerFailure(res, result);
  }));

  // From the Stopped page: the person lifts the stop and gets one new confirmation request.
  app.post("/wake-rules/disable/:token/again", rawForm, (req, res) => guarded(res, async () => {
    const token = tokenOf(req);
    if (!token) return page(res, 404, ...INVALID);
    if (!bodyIs(req, AGAIN)) return page(res, 400, "Press the button", "Open the link from the email and press the button.");
    const cipher = loadConnectorCipher();
    if (!cipher) return page(res, 503, "Not available", "Email requests are not set up on this server.");
    const result = await requestWakeEmailConfirmationAgain(
      hashWakeLinkToken(token),
      (ruleId, confirmExpiresAt) => hashWakeLinkToken(wakeEmailConfirmToken(cipher, ruleId, confirmExpiresAt)),
    );
    if (result.outcome === "done") {
      queueWakeRuleInvalidation(result.rule.room_id);
      return page(res, 200, "Request sent", "A new confirmation request is on its way to this address. Open it and press Confirm to allow the emails.");
    }
    answerFailure(res, result);
  }));
}
