import crypto from "crypto";
import type { Express } from "express";

import {
  consumeAuthState,
  createOwnerToken,
  createSession,
  createAuthState,
  deleteSessionByToken,
  refreshProviderAccessTokenForAccount,
  upsertAccount,
} from "./db.js";
import { db } from "./db/client.js";
import { system_github_app } from "./db/schema.js";
import { buildGitHubAppSetupRedirectPath } from "./github-app-installation.js";
import {
  clearGitHubRepoAccessCacheForLogin,
} from "./github-repo-access.js";
import {
  buildGitHubAuthorizeUrl,
  exchangeGitHubDeviceCodeForAccessToken,
  exchangeGitHubCodeForAccessToken,
  fetchGitHubUser,
  requestGitHubDeviceCode,
} from "./github-oauth.js";
import {
  clearSessionCookie,
  parseCookies,
  respondWithInternalError,
  sanitizeRedirectPath,
  setSessionCookie,
  type AuthenticatedRequest,
} from "./http-helpers.js";

interface PendingDeviceAuth {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  intervalSeconds: number;
  expiresAt: number;
  lastPollAt: number | null;
}

const pendingDeviceAuths = new Map<string, PendingDeviceAuth>();

function cleanupExpiredDeviceAuths(): void {
  const now = Date.now();
  for (const [requestId, auth] of pendingDeviceAuths.entries()) {
    if (auth.expiresAt <= now) {
      pendingDeviceAuths.delete(requestId);
    }
  }
}

export function registerGitHubAppCallbackRoute(app: Express): void {
  app.get("/auth/github/app/callback", async (req, res) => {
    const code = typeof req.query.code === "string" ? req.query.code : undefined;
    const state = typeof req.query.state === "string" ? req.query.state : undefined;
    const setupAction = typeof req.query.setup_action === "string" ? req.query.setup_action : undefined;

    let stateValid = false;
    let redirectTo = "/";
    if (state) {
      const authState = await consumeAuthState(state);
      if (authState) {
        stateValid = true;
        redirectTo = authState.redirect_to || "/";
      }
    }

    if (code) {
      if (!stateValid) {
        res.status(401).send("<html><body><h2>Error: Invalid State</h2><p>Your session may have expired.</p></body></html>");
        return;
      }
      // Handling Manifest Creation Callback
      try {
        const response = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
          method: "POST",
          headers: {
            "Accept": "application/vnd.github.v3+json",
          }
        });
        if (response.ok) {
          const data = await response.json();

          await db.transaction(async (tx) => {
            // Remove old configs (limit 1 logic)
            await tx.delete(system_github_app);

            // Insert into system_github_app
            await tx.insert(system_github_app).values({
              app_id: String(data.id),
              app_slug: data.slug,
              client_id: data.client_id,
              client_secret: data.client_secret,
              private_key: data.pem,
              webhook_secret: data.webhook_secret,
            });
          });

          res.send(`<html><body><h2>GitHub App Created Successfully</h2><p>You can close this window now.</p><script>setTimeout(() => window.location.href='${redirectTo}', 2000)</script></body></html>`);
          return;
        } else {
          const err = await response.text();
          res.status(500).send(`Failed to convert manifest code: ${err}`);
          return;
        }
      } catch (e) {
        res.status(500).send(`Exception converting manifest code: ${String(e)}`);
        return;
      }
    }

    res.redirect(
      302,
      buildGitHubAppSetupRedirectPath({
        redirectTo,
        setupAction,
        stateValid,
      })
    );
  });
}

export function registerAuthRoutes(app: Express): void {
  app.post("/auth/github/login", async (req, res) => {
    const redirectTo = sanitizeRedirectPath(
      typeof req.body?.redirect_to === "string" ? req.body.redirect_to : undefined,
      "/"
    );
    const state = crypto.randomBytes(24).toString("hex");

    await createAuthState(state, redirectTo);

    try {
      const authUrl = buildGitHubAuthorizeUrl(state);
      res.json({ auth_url: authUrl, state, redirect_to: redirectTo });
    } catch (error) {
      respondWithInternalError(
        res,
        "POST /auth/github/login",
        error,
        "GitHub login is currently unavailable."
      );
    }
  });

  app.post("/auth/device/start", async (_req, res) => {
    cleanupExpiredDeviceAuths();

    try {
      const device = await requestGitHubDeviceCode();
      const requestId = crypto.randomBytes(16).toString("hex");
      pendingDeviceAuths.set(requestId, {
        deviceCode: device.device_code,
        userCode: device.user_code,
        verificationUri: device.verification_uri,
        intervalSeconds: device.interval,
        expiresAt: Date.now() + device.expires_in * 1000,
        lastPollAt: null,
      });

      res.status(201).json({
        request_id: requestId,
        user_code: device.user_code,
        verification_uri: device.verification_uri,
        expires_in: device.expires_in,
        interval: device.interval,
      });
    } catch (error) {
      respondWithInternalError(
        res,
        "POST /auth/device/start",
        error,
        "Device authorization is currently unavailable."
      );
    }
  });

  app.get("/auth/device/poll/:requestId", async (req, res) => {
    cleanupExpiredDeviceAuths();

    const requestId = String(req.params.requestId);
    const pending = pendingDeviceAuths.get(requestId);
    if (!pending) {
      res.status(404).json({ error: "Unknown or expired device authorization request" });
      return;
    }

    const now = Date.now();
    if (pending.lastPollAt && now - pending.lastPollAt < pending.intervalSeconds * 1000) {
      res.status(429).json({
        error: "Polling too quickly",
        interval: pending.intervalSeconds,
      });
      return;
    }

    pending.lastPollAt = now;

    try {
      const result = await exchangeGitHubDeviceCodeForAccessToken({
        deviceCode: pending.deviceCode,
      });

      if (result.status === "pending" || result.status === "slow_down") {
        if (result.status === "slow_down") {
          pending.intervalSeconds = Math.max(
            pending.intervalSeconds + 5,
            result.interval ?? pending.intervalSeconds + 5
          );
        }

        res.json({
          status: result.status,
          interval: pending.intervalSeconds,
          expires_in: Math.max(0, Math.ceil((pending.expiresAt - now) / 1000)),
        });
        return;
      }

      if (result.status === "denied" || result.status === "expired") {
        pendingDeviceAuths.delete(requestId);
        res.status(result.status === "denied" ? 403 : 410).json({ status: result.status });
        return;
      }

      const githubUser = await fetchGitHubUser(result.accessToken);
      const account = await upsertAccount({
        provider: "github",
        provider_user_id: String(githubUser.id),
        login: githubUser.login,
        display_name: githubUser.name,
        avatar_url: githubUser.avatar_url,
      });
      await refreshProviderAccessTokenForAccount(account.id, result.accessToken);
      clearGitHubRepoAccessCacheForLogin(account.login);

      const ownerToken = crypto.randomBytes(32).toString("hex");
      const ownerCredential = await createOwnerToken({
        accountId: account.id,
        githubUserId: String(githubUser.id),
        token: ownerToken,
        providerAccessToken: result.accessToken,
        oauthTokenExpiresAt: null,
      });
      pendingDeviceAuths.delete(requestId);

      res.json({
        status: "authorized",
        letagents_token: ownerToken,
        owner_token_id: ownerCredential.token_id,
        oauth_token_expires_at: ownerCredential.oauth_token_expires_at,
        account: {
          id: account.id,
          login: account.login,
          display_name: account.display_name,
          avatar_url: account.avatar_url,
          provider: account.provider,
          provider_user_id: account.provider_user_id,
        },
      });
    } catch (error) {
      respondWithInternalError(
        res,
        "GET /auth/device/poll/:requestId",
        error,
        "Device authorization polling failed."
      );
    }
  });

  app.get("/auth/github/callback", async (req, res) => {
    const code = typeof req.query.code === "string" ? req.query.code : undefined;
    const state = typeof req.query.state === "string" ? req.query.state : undefined;

    if (!code || !state) {
      res.status(400).json({ error: "Missing code or state" });
      return;
    }

    const authState = await consumeAuthState(state);
    if (!authState) {
      res.status(400).json({ error: "Invalid or expired auth state" });
      return;
    }

    try {
      const accessToken = await exchangeGitHubCodeForAccessToken(code);
      const githubUser = await fetchGitHubUser(accessToken);
      const account = await upsertAccount({
        provider: "github",
        provider_user_id: String(githubUser.id),
        login: githubUser.login,
        display_name: githubUser.name,
        avatar_url: githubUser.avatar_url,
      });
      await refreshProviderAccessTokenForAccount(account.id, accessToken);
      clearGitHubRepoAccessCacheForLogin(account.login);

      const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
      const sessionToken = crypto.randomBytes(32).toString("hex");
      await createSession(account.id, sessionToken, expiresAt, accessToken);
      setSessionCookie(res, sessionToken);

      if (authState.redirect_to) {
        res.redirect(authState.redirect_to);
        return;
      }

      res.json({
        authenticated: true,
        account: {
          id: account.id,
          login: account.login,
          display_name: account.display_name,
          avatar_url: account.avatar_url,
        },
      });
    } catch (error) {
      respondWithInternalError(
        res,
        "GET /auth/github/callback",
        error,
        "GitHub authentication failed."
      );
    }
  });

  app.get("/auth/session", (req: AuthenticatedRequest, res) => {
    if (!req.sessionAccount) {
      res.json({ authenticated: false });
      return;
    }

    res.json({
      authenticated: true,
      account: {
        id: req.sessionAccount.account_id,
        provider: req.sessionAccount.provider,
        provider_user_id: req.sessionAccount.provider_user_id,
        login: req.sessionAccount.login,
        display_name: req.sessionAccount.display_name,
        avatar_url: req.sessionAccount.avatar_url,
      },
    });
  });

  app.post("/auth/logout", async (req: AuthenticatedRequest, res) => {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies.letagents_session) {
      await deleteSessionByToken(cookies.letagents_session);
    }
    clearSessionCookie(res);
    res.json({ success: true });
  });
}
