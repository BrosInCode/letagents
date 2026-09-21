import { createHash, randomBytes, randomUUID } from "node:crypto";
import express, { type Express, type Response } from "express";
import { pool } from "../../db/client.js";
import { createAuthState } from "../../db.js";
import { buildGitHubAuthorizeUrl } from "../../github/oauth.js";
import type { AuthenticatedRequest } from "../../http/helpers.js";
import { requireAppSession } from "../../request/app-session.js";
import { checkDeviceAuthStartRateLimit } from "./index.js";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
function page(res: Response, title: string, body: string) {
  res.set({
    "Cache-Control": "no-store",
    // Native form POSTs under no-referrer send Origin: null. Preserve our
    // origin for consent validation without leaking the URL to other sites.
    "Referrer-Policy": "same-origin",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  });
  res
    .type("html")
    .send(
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · LetAgents</title><style>html{color-scheme:dark;font:16px/1.5 system-ui;background:#0a0a0a;color:#fafafa}main{max-width:420px;margin:12vh auto;padding:32px}h1{font-size:26px;letter-spacing:-.03em}p{color:#a1a1aa}strong{color:#fafafa}code{display:block;font-size:28px;letter-spacing:.15em;margin:24px 0}button{font:inherit;background:#fafafa;color:#09090b;border:0;border-radius:8px;padding:12px 20px;cursor:pointer}button:focus-visible{outline:3px solid #3b82f6;outline-offset:4px}</style><main><p>LetAgents</p><h1>${title}</h1>${body}</main></html>`,
    );
}

/** A proof-bound browser approval issues distinct app and agent credentials.
 * Owner tokens cannot approve this flow, even with desktop-identifying headers.
 */
export function registerAppLoginRoutes(app: Express): void {
  app.post("/auth/app/start", async (req, res) => {
    if (!checkDeviceAuthStartRateLimit(req.ip || "unknown")) {
      res
        .status(429)
        .json({ error: "Please wait before trying to sign in again." });
      return;
    }
    const challenge = req.body?.code_challenge;
    if (typeof challenge !== "string" || !/^[a-f0-9]{64}$/.test(challenge)) {
      res.status(400).json({ error: "A sign-in proof is required." });
      return;
    }
    const id = randomUUID();
    const code = randomBytes(4).toString("hex").toUpperCase();
    await pool.query("DELETE FROM app_login_requests WHERE expires_at < now()");
    await pool.query(
      "INSERT INTO app_login_requests (id, secret_hash, user_code, expires_at) VALUES ($1,$2,$3,now() + interval '10 minutes')",
      [id, challenge, code],
    );
    const base =
      process.env.LETAGENTS_BASE_URL ||
      process.env.PUBLIC_API_URL ||
      `http://localhost:${process.env.PORT || 3001}`;
    res
      .set("Cache-Control", "no-store")
      .status(201)
      .json({
        request_id: id,
        user_code: code,
        verification_uri: `${base}/auth/app/authorize/${id}`,
        expires_in: 600,
        interval: 2,
      });
  });

  app.get("/auth/app/authorize/:id", async (req: AuthenticatedRequest, res) => {
    if (req.headers.authorization) {
      res.status(403).send("Open this link in your browser.");
      return;
    }
    const pending = await pool.query(
      "SELECT user_code FROM app_login_requests WHERE id=$1 AND expires_at > now() AND NOT approved",
      [req.params.id],
    );
    if (!pending.rowCount) {
      page(
        res,
        "This sign-in has expired",
        "<p>Return to LetAgents and start again.</p>",
      );
      return;
    }
    if (req.authKind !== "session" || !req.sessionAccount) {
      const state = randomBytes(24).toString("hex");
      await createAuthState(
        state,
        `/auth/app/authorize/${encodeURIComponent(String(req.params.id))}`,
      );
      res.redirect(buildGitHubAuthorizeUrl(state));
      return;
    }
    const csrf = randomBytes(32).toString("hex");
    await pool.query(
      "UPDATE app_login_requests SET consent_session_id=$2, consent_hash=$3 WHERE id=$1 AND NOT approved",
      [
        req.params.id,
        "id" in req.sessionAccount ? req.sessionAccount.id : null,
        digest(csrf),
      ],
    );
    page(
      res,
      "Connect LetAgents Desktop",
      `<p>Signed in as <strong>${escape(req.sessionAccount.login)}</strong>.</p><p>Check that this code matches the one in your app:</p><code>${escape(pending.rows[0].user_code)}</code><p>This lets the app access your account and private messages. Connected agents receive a separate credential with no private-message access.</p><form method="post"><input type="hidden" name="csrf" value="${csrf}"><button type="submit">Connect this app</button></form><p>Only continue if you started this sign-in yourself.</p>`,
    );
  });

  app.post(
    "/auth/app/authorize/:id",
    express.urlencoded({ extended: false, limit: "2kb" }),
    async (req: AuthenticatedRequest, res) => {
      if (req.headers.authorization || !requireAppSession(req, res)) {
        if (!res.headersSent) res.sendStatus(403);
        return;
      }
      const csrf = req.body?.csrf;
      if (typeof csrf !== "string") {
        res.sendStatus(403);
        return;
      }
      const result = await pool.query(
        "UPDATE app_login_requests SET approved=true, consent_hash=NULL WHERE id=$1 AND consent_session_id=$2 AND consent_hash=$3 AND expires_at > now() AND NOT approved",
        [
          req.params.id,
          "id" in req.sessionAccount! ? req.sessionAccount.id : null,
          digest(csrf),
        ],
      );
      if (!result.rowCount) {
        res.sendStatus(403);
        return;
      }
      page(
        res,
        "You’re connected",
        "<p>Return to LetAgents Desktop. You can close this tab.</p>",
      );
    },
  );

  app.post("/auth/app/exchange", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const { request_id: id, code_verifier: verifier } = req.body ?? {};
    if (
      typeof id !== "string" ||
      typeof verifier !== "string" ||
      verifier.length < 32 ||
      verifier.length > 256
    ) {
      res.sendStatus(400);
      return;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        "SELECT * FROM app_login_requests WHERE id=$1 AND secret_hash=$2 AND expires_at>now() FOR UPDATE",
        [id, digest(verifier)],
      );
      const pending = result.rows[0];
      if (!pending) {
        await client.query("ROLLBACK");
        res.status(410).json({ status: "expired" });
        return;
      }
      if (!pending.approved) {
        await client.query("ROLLBACK");
        res.json({ status: "pending", interval: 2 });
        return;
      }
      const source = await client.query(
        "SELECT a.*, s.provider_access_token FROM auth_sessions s JOIN accounts a ON a.id=s.account_id WHERE s.id=$1 AND s.expires_at>now()",
        [pending.consent_session_id],
      );
      const account = source.rows[0];
      if (!account) {
        await client.query("ROLLBACK");
        res.status(410).json({ status: "expired" });
        return;
      }
      const appToken = randomBytes(32).toString("hex");
      const agentToken = randomBytes(32).toString("hex");
      const ownerId = `owner_token_${randomUUID()}`;
      await client.query(
        "INSERT INTO auth_sessions (id,account_id,token_hash,provider_access_token,expires_at,created_at) VALUES ($1,$2,$3,$4,now()+interval '30 days',now())",
        [
          `sess_${randomUUID()}`,
          account.id,
          digest(appToken),
          account.provider_access_token,
        ],
      );
      await client.query(
        "INSERT INTO owner_tokens (token_id,account_id,github_user_id,token_hash,provider_access_token,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,now(),now())",
        [
          ownerId,
          account.id,
          account.provider_user_id,
          digest(agentToken),
          account.provider_access_token,
        ],
      );
      await client.query("DELETE FROM app_login_requests WHERE id=$1", [id]);
      await client.query("COMMIT");
      res.json({
        status: "authorized",
        app_session: appToken,
        agent_token: agentToken,
        owner_token_id: ownerId,
        account: {
          id: account.id,
          provider: account.provider,
          provider_user_id: account.provider_user_id,
          login: account.login,
          display_name: account.display_name,
          avatar_url: account.avatar_url,
        },
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
}
