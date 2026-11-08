import { randomBytes } from "node:crypto";
import type { Express } from "express";

import { createAuthState } from "../../db.js";
import { buildGitHubAuthorizeUrl } from "../../github/oauth.js";
import { page } from "./app-login.js";

const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const DONE_PATH = "/auth/github/organizations/done";

/**
 * The browser step that asks GitHub for organization-read access again. The
 * callback refreshes the GitHub token on every session of the account, so the
 * desktop app picks up the new scope without signing in again.
 */
export function registerOrganizationConsentRoutes(
  app: Express,
  deps = { createAuthState, buildGitHubAuthorizeUrl },
): void {
  app.get("/auth/github/organizations", async (req, res) => {
    if (req.headers.authorization) {
      res.status(403).send("Open this link in your browser.");
      return;
    }
    const login = req.query.login;
    if (login !== undefined && (typeof login !== "string" || !GITHUB_LOGIN.test(login))) {
      res.status(400).json({ error: "invalid_login" });
      return;
    }
    const state = randomBytes(24).toString("hex");
    await deps.createAuthState(state, DONE_PATH);
    res.redirect(deps.buildGitHubAuthorizeUrl(state, {
      extraScopes: ["read:org"],
      ...(typeof login === "string" ? { login } : {}),
    }));
  });

  app.get(DONE_PATH, (_req, res) => {
    page(res, "GitHub access updated", "<p>Return to LetAgents. You can close this tab.</p>");
  });
}
