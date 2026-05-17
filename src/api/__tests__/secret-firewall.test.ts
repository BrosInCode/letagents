/**
 * Tests for Secret Firewall — p4.2
 *
 * Uses node:test + node:assert/strict (project convention).
 *
 * Note: Test secret values are constructed programmatically to avoid
 * tripping GitHub's push protection. The values match our detection
 * patterns but are not real credentials.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  scanFile,
  isPathBlocked,
  scanContent,
} from "../rental/secret-firewall.js";

// Construct test tokens programmatically to avoid GitHub push protection
const FAKE_STRIPE_LIVE = "sk_live_" + "x".repeat(24);
const FAKE_STRIPE_TEST = "sk_test_" + "y".repeat(24);
const FAKE_GITHUB_PAT = "ghp_" + "A".repeat(36);
const FAKE_AWS_KEY = "AKIA" + "X".repeat(16);
const FAKE_NPM_TOKEN = "npm_" + "z".repeat(36);

// ---------------------------------------------------------------------------
// Path denylist tests
// ---------------------------------------------------------------------------

describe("SecretFirewall — Path Denylist", () => {
  it("blocks .env file", () => {
    const result = scanFile(".env", "SECRET_KEY=supersecret");
    assert.equal(result.verdict, "blocked");
    assert.equal(result.content, null);
    assert.ok(result.findings.length > 0);
    assert.ok(
      result.findings[0].detail.includes("Environment"),
      "should mention environment",
    );
  });

  it("blocks .env.production", () => {
    const result = scanFile(".env.production", "DB_PASSWORD=prod123");
    assert.equal(result.verdict, "blocked");
  });

  it("blocks .env.custom (wildcard)", () => {
    const result = scanFile(".env.custom", "CUSTOM_SECRET=abc");
    assert.equal(result.verdict, "blocked");
  });

  it("blocks nested .npmrc", () => {
    const result = scanFile(".npmrc", "//registry:_authToken=xyz");
    assert.equal(result.verdict, "blocked");
  });

  it("blocks id_rsa (SSH key)", () => {
    const result = scanFile("id_rsa", "-----BEGIN RSA PRIVATE KEY-----");
    assert.equal(result.verdict, "blocked");
  });

  it("blocks .pem extension", () => {
    const result = scanFile("server.pem", "cert data");
    assert.equal(result.verdict, "blocked");
  });

  it("blocks .key extension", () => {
    const result = scanFile("private.key", "key data");
    assert.equal(result.verdict, "blocked");
  });

  it("allows normal source files", () => {
    const result = scanFile("src/index.ts", 'console.log("hello");');
    assert.equal(result.verdict, "passed");
    assert.notEqual(result.content, null);
  });

  it("isPathBlocked returns true for blocked paths", () => {
    assert.ok(isPathBlocked(".env"));
    assert.ok(isPathBlocked(".env.local"));
    assert.ok(isPathBlocked("server.pem"));
    assert.ok(isPathBlocked("private.key"));
  });

  it("isPathBlocked returns false for safe paths", () => {
    assert.ok(!isPathBlocked("src/index.ts"));
    assert.ok(!isPathBlocked("package.json"));
    assert.ok(!isPathBlocked("README.md"));
  });

  it("blocks files in .ssh directory", () => {
    assert.ok(isPathBlocked(".ssh/id_rsa"));
    assert.ok(isPathBlocked(".ssh/config"));
    assert.ok(isPathBlocked("home/.ssh/authorized_keys"));
  });

  it("blocks files in .aws directory", () => {
    assert.ok(isPathBlocked(".aws/credentials"));
    assert.ok(isPathBlocked(".aws/config"));
  });

  it("blocks service-account*.json wildcard", () => {
    assert.ok(isPathBlocked("service-account.json"));
    assert.ok(isPathBlocked("service_account.json"));
    assert.ok(isPathBlocked("service-account-prod.json"));
    assert.ok(isPathBlocked("service-account-12345.json"));
  });
});

// ---------------------------------------------------------------------------
// Secret regex detection tests
// ---------------------------------------------------------------------------

describe("SecretFirewall — Secret Regexes", () => {
  it("detects and redacts Stripe live key", () => {
    const content = `const key = "${FAKE_STRIPE_LIVE}";`;
    const result = scanFile("src/payments.ts", content);

    assert.equal(result.verdict, "redacted");
    assert.ok(result.redactionCount >= 1, "should redact ≥1 secret");
    assert.ok(result.content, "should have content");
    assert.ok(
      result.content!.includes("REDACTED_STRIPE_SK"),
      "should contain Stripe redaction placeholder",
    );
    assert.ok(
      !result.content!.includes("sk_live_"),
      "should not contain original key prefix",
    );
  });

  it("detects and redacts Stripe test key", () => {
    const content = `STRIPE_KEY=${FAKE_STRIPE_TEST}`;
    const result = scanFile("config.ts", content);

    assert.equal(result.verdict, "redacted");
    assert.ok(result.content!.includes("REDACTED_STRIPE_SK"));
  });

  it("detects and redacts GitHub PAT", () => {
    const content = `token: ${FAKE_GITHUB_PAT}`;
    const result = scanFile("auth.ts", content);

    assert.equal(result.verdict, "redacted");
    assert.ok(result.content!.includes("REDACTED_GITHUB_PAT"));
  });

  it("detects and redacts AWS access key", () => {
    const content = `aws_access_key_id = ${FAKE_AWS_KEY}`;
    const result = scanFile("aws.config", content);

    assert.equal(result.verdict, "redacted");
    assert.ok(result.content!.includes("REDACTED_AWS_KEY"));
  });

  it("detects and redacts npm token", () => {
    const content = `//registry.npmjs.org/:_authToken=${FAKE_NPM_TOKEN}`;
    const result = scanFile("config.ts", content);

    assert.equal(result.verdict, "redacted");
    assert.ok(result.content!.includes("REDACTED_NPM_TOKEN"));
  });

  it("detects and redacts private key (PEM)", () => {
    const content = `
const key = \`-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA0Y7pJHwE
-----END RSA PRIVATE KEY-----\`;
    `;
    const result = scanFile("cert.ts", content);

    assert.equal(result.verdict, "redacted");
    assert.ok(result.content!.includes("REDACTED_PRIVATE_KEY"));
  });

  it("passes clean code with no secrets", () => {
    const content = `
export function add(a: number, b: number): number {
  return a + b;
}

const config = {
  port: 3000,
  host: "localhost",
  debug: true,
};
    `;
    const result = scanFile("src/utils.ts", content);

    assert.equal(result.verdict, "passed");
    assert.equal(result.redactionCount, 0);
  });

  it("handles multiple secrets in one file", () => {
    const content = `
const stripeKey = "${FAKE_STRIPE_LIVE}";
const githubToken = "${FAKE_GITHUB_PAT}";
    `;
    const result = scanFile("secrets.ts", content);

    assert.equal(result.verdict, "redacted");
    assert.ok(result.redactionCount >= 2, "should redact ≥2 secrets");
  });
});

// ---------------------------------------------------------------------------
// Redaction replacement tests
// ---------------------------------------------------------------------------

describe("SecretFirewall — Redaction", () => {
  it("replaces secret values with placeholders", () => {
    const content = `process.env.STRIPE_SECRET_KEY = "${FAKE_STRIPE_LIVE}";`;
    const result = scanFile("config.ts", content);

    assert.ok(result.content, "content should not be null");
    // Original secret should be gone
    assert.ok(
      !result.content!.includes("sk_live_"),
      "original secret should be removed",
    );
    // Placeholder should be present
    assert.ok(
      result.content!.includes("REDACTED_STRIPE_SK"),
      "placeholder should be present",
    );
  });

  it("preserves surrounding code", () => {
    const content = `
const a = 1;
const key = "${FAKE_STRIPE_LIVE}";
const b = 2;
    `.trim();
    const result = scanFile("test.ts", content);

    assert.ok(result.content!.includes("const a = 1;"));
    assert.ok(result.content!.includes("const b = 2;"));
  });
});

// ---------------------------------------------------------------------------
// Content-only scan tests
// ---------------------------------------------------------------------------

describe("SecretFirewall — Content Scan", () => {
  it("scans raw content without path check", () => {
    const result = scanContent(`Token: ${FAKE_GITHUB_PAT}`);
    assert.equal(result.verdict, "redacted");
    assert.ok(result.content!.includes("REDACTED_GITHUB_PAT"));
  });

  it("passes safe command output", () => {
    const result = scanContent("$ ls -la\ntotal 32\ndrwxr-xr-x 4 user staff 128 Jan 1 12:00 .");
    assert.equal(result.verdict, "passed");
  });
});
