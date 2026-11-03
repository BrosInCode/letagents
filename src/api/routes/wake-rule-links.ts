/**
 * The two links in a wake email. They are opened from a mail client, so they
 * need no sign-in: the token itself is the proof (an HMAC under the connector
 * key; the table keeps only its SHA-256). The answer is one plain line.
 */
import type { Express, Response } from "express";

import { confirmWakeEmailRule, stopWakeEmailRule } from "../db/wake-rules.js";
import { queueWakeRuleInvalidation } from "../server/events.js";
import { WAKE_LINK_TOKEN, hashWakeLinkToken } from "../wake-rules/email.js";

function plain(res: Response, status: number, text: string): void {
  res.status(status)
    .set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" })
    .type("text/plain; charset=utf-8")
    .send(`${text}\n`);
}

function tokenOf(value: unknown): string | null {
  return typeof value === "string" && WAKE_LINK_TOKEN.test(value) ? value : null;
}

export function registerWakeRuleLinkRoutes(app: Express): void {
  app.get("/wake-rules/confirm/:token", async (req, res) => {
    const token = tokenOf(req.params.token);
    if (!token) return plain(res, 404, "This link is not valid.");
    try {
      const result = await confirmWakeEmailRule(hashWakeLinkToken(token));
      if (result.outcome === "done") {
        queueWakeRuleInvalidation(result.rule.room_id);
        return plain(res, 200, `Confirmed. LetAgents will email this address when a message in the room is for ${result.rule.agent_name}.`);
      }
      if (result.outcome === "already") return plain(res, 200, "This address is already confirmed.");
      if (result.outcome === "expired") return plain(res, 410, "This link has expired. Ask the agent to add its email rule again for a new link.");
      if (result.outcome === "ended") return plain(res, 410, "This email rule has already ended or been confirmed.");
      return plain(res, 404, "This link is not valid.");
    } catch (error) {
      console.error("[wake email] confirmation failed", error instanceof Error ? error.message : error);
      return plain(res, 500, "Something went wrong. Please open the link again.");
    }
  });

  // GET for a person; POST for one-click unsubscribe from the mail client (RFC 8058).
  const stop = async (req: { params: Record<string, string | string[]> }, res: Response) => {
    const token = tokenOf(req.params.token);
    if (!token) return plain(res, 404, "This link is not valid.");
    try {
      const result = await stopWakeEmailRule(hashWakeLinkToken(token));
      if (result.outcome === "done") {
        queueWakeRuleInvalidation(result.rule.room_id);
        return plain(res, 200, `Stopped. LetAgents will not email this address for ${result.rule.agent_name} again unless you confirm a new request.`);
      }
      if (result.outcome === "already") return plain(res, 200, "These emails are already stopped.");
      if (result.outcome === "ended") return plain(res, 200, "This email rule has already ended.");
      return plain(res, 404, "This link is not valid.");
    } catch (error) {
      console.error("[wake email] stop failed", error instanceof Error ? error.message : error);
      return plain(res, 500, "Something went wrong. Please open the link again.");
    }
  };
  app.get("/wake-rules/disable/:token", stop);
  app.post("/wake-rules/disable/:token", stop);
}
