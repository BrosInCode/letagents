import assert from "node:assert/strict";
import test from "node:test";

import { getGitHubAppConfig, getGitHubOAuthConfig, hasGitHubAppConfig } from "../github-config.js";

function withEnv(
  values: Record<string, string | undefined>,
  fn: () => void | Promise<void>
): Promise<void> | void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  const restore = () => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };

  try {
    const result = fn();
    if (result && typeof (result as Promise<void>).then === "function") {
      return (result as Promise<void>).finally(restore);
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

test("getGitHubOAuthConfig preserves the existing OAuth defaults", () =>
  withEnv(
    {
      LETAGENTS_BASE_URL: "https://letagents.chat",
      PUBLIC_API_URL: undefined,
      GITHUB_CLIENT_ID: "oauth-client",
      GITHUB_CLIENT_SECRET: "oauth-secret",
      GITHUB_OAUTH_SCOPES: undefined,
    },
    () => {
      const config = getGitHubOAuthConfig();
      assert.equal(config.clientId, "oauth-client");
      assert.equal(config.clientSecret, "oauth-secret");
      assert.equal(config.baseUrl, "https://letagents.chat");
      assert.equal(config.scopes, "read:user,repo");
      assert.equal(config.callbackUrl, "https://letagents.chat/auth/github/callback");
    }
  ));

test("getGitHubAppConfig normalizes multiline private keys and callback url", () =>
  withEnv(
    {
      LETAGENTS_BASE_URL: "https://letagents.chat",
      GITHUB_APP_ID: "12345",
      GITHUB_APP_CLIENT_ID: "iv-app-client",
      GITHUB_APP_CLIENT_SECRET: "app-secret",
      GITHUB_APP_PRIVATE_KEY: "-----BEGIN KEY-----\\nline-1\\nline-2\\n-----END KEY-----",
      GITHUB_WEBHOOK_SECRET: "webhook-secret",
    },
    () => {
      const config = getGitHubAppConfig();
      assert.equal(config.appId, "12345");
      assert.equal(config.clientId, "iv-app-client");
      assert.equal(config.clientSecret, "app-secret");
      assert.equal(config.privateKey, "-----BEGIN KEY-----\nline-1\nline-2\n-----END KEY-----");
      assert.equal(config.webhookSecret, "webhook-secret");
      assert.equal(config.callbackUrl, "https://letagents.chat/auth/github/app/callback");
      assert.equal(hasGitHubAppConfig(), true);
    }
  ));

test("hasGitHubAppConfig returns false when app credentials are incomplete", () =>
  withEnv(
    {
      LETAGENTS_BASE_URL: undefined,
      PUBLIC_API_URL: undefined,
      GITHUB_APP_ID: "12345",
      GITHUB_APP_CLIENT_ID: "iv-app-client",
      GITHUB_APP_CLIENT_SECRET: undefined,
      GITHUB_APP_PRIVATE_KEY: "-----BEGIN KEY-----\\nline-1\\n-----END KEY-----",
      GITHUB_WEBHOOK_SECRET: "webhook-secret",
    },
    () => {
      assert.equal(hasGitHubAppConfig(), false);
      const config = getGitHubAppConfig();
      assert.equal(config.baseUrl, "http://localhost:3001");
    }
  ));
