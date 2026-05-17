/**
 * Secret Firewall Patterns — p4.2
 *
 * Known secret detection patterns for the Secret Firewall.
 * Per spec §12.2, uses layered detection:
 *
 * 1. Filename/path denylist
 * 2. Known secret regex patterns (GitHub / npm / cloud / vendor tokens)
 * 3. Shannon entropy detector for random-looking high-entropy strings
 *
 * V1 is strict: false positives are safer than leaking keys.
 */

// ---------------------------------------------------------------------------
// 1. Filename / path denylist
// ---------------------------------------------------------------------------

/**
 * Files that are ALWAYS blocked from exposure, regardless of scope.
 * These are categorized by risk level.
 */
export const BLOCKED_FILENAMES: ReadonlyArray<{
  pattern: string;
  reason: string;
}> = [
  // Environment files
  { pattern: ".env", reason: "Environment variables file" },
  { pattern: ".env.local", reason: "Local environment variables" },
  { pattern: ".env.production", reason: "Production environment variables" },
  { pattern: ".env.development", reason: "Development environment variables" },
  { pattern: ".env.staging", reason: "Staging environment variables" },
  { pattern: ".env.test", reason: "Test environment variables" },

  // Credential files
  { pattern: ".git-credentials", reason: "Git credentials" },
  { pattern: ".netrc", reason: "Network credentials" },
  { pattern: ".npmrc", reason: "npm registry credentials" },
  { pattern: ".pypirc", reason: "PyPI credentials" },
  { pattern: ".docker/config.json", reason: "Docker registry credentials" },
  { pattern: ".kube/config", reason: "Kubernetes credentials" },

  // SSH keys
  { pattern: "id_rsa", reason: "SSH private key" },
  { pattern: "id_ed25519", reason: "SSH private key" },
  { pattern: "id_ecdsa", reason: "SSH private key" },
  { pattern: "id_dsa", reason: "SSH private key" },

  // Cloud credentials
  { pattern: "credentials.json", reason: "Cloud service credentials" },
  { pattern: "service-account.json", reason: "GCP service account" },
  { pattern: "service_account.json", reason: "GCP service account" },
  { pattern: ".vault-token", reason: "HashiCorp Vault token" },

  // Secrets files
  { pattern: "secrets.yaml", reason: "Secrets configuration" },
  { pattern: "secrets.yml", reason: "Secrets configuration" },
  { pattern: "secrets.json", reason: "Secrets configuration" },
  { pattern: "secret.yaml", reason: "Secrets configuration" },
  { pattern: "secret.yml", reason: "Secrets configuration" },
  { pattern: "secret.json", reason: "Secrets configuration" },
];

/**
 * File extension denylist — files with these extensions are blocked.
 */
export const BLOCKED_EXTENSIONS: ReadonlyArray<{
  ext: string;
  reason: string;
}> = [
  { ext: ".pem", reason: "PEM certificate/key" },
  { ext: ".key", reason: "Private key file" },
  { ext: ".p12", reason: "PKCS12 keystore" },
  { ext: ".pfx", reason: "PFX certificate" },
  { ext: ".jks", reason: "Java keystore" },
  { ext: ".keystore", reason: "Keystore file" },
];

// ---------------------------------------------------------------------------
// 2. Known secret regex patterns
// ---------------------------------------------------------------------------

/**
 * Named regex patterns for known API keys and tokens.
 * Each pattern captures the secret value for redaction.
 */
export const SECRET_PATTERNS: ReadonlyArray<{
  name: string;
  regex: RegExp;
  placeholder: string;
}> = [
  // GitHub
  {
    name: "GitHub PAT (classic)",
    regex: /ghp_[A-Za-z0-9_]{36,251}/g,
    placeholder: "REDACTED_GITHUB_PAT",
  },
  {
    name: "GitHub PAT (fine-grained)",
    regex: /github_pat_[A-Za-z0-9_]{22,82}_[A-Za-z0-9]{6,255}/g,
    placeholder: "REDACTED_GITHUB_PAT",
  },
  {
    name: "GitHub OAuth token",
    regex: /gho_[A-Za-z0-9_]{36,251}/g,
    placeholder: "REDACTED_GITHUB_OAUTH",
  },
  {
    name: "GitHub App token",
    regex: /ghu_[A-Za-z0-9_]{36,251}/g,
    placeholder: "REDACTED_GITHUB_APP",
  },
  {
    name: "GitHub Server token",
    regex: /ghs_[A-Za-z0-9_]{36,251}/g,
    placeholder: "REDACTED_GITHUB_SERVER",
  },
  {
    name: "GitHub Refresh token",
    regex: /ghr_[A-Za-z0-9_]{36,251}/g,
    placeholder: "REDACTED_GITHUB_REFRESH",
  },

  // npm
  {
    name: "npm token",
    regex: /npm_[A-Za-z0-9]{36}/g,
    placeholder: "REDACTED_NPM_TOKEN",
  },

  // Stripe
  {
    name: "Stripe live secret key",
    regex: /sk_live_[A-Za-z0-9]{24,99}/g,
    placeholder: "REDACTED_STRIPE_SK",
  },
  {
    name: "Stripe test secret key",
    regex: /sk_test_[A-Za-z0-9]{24,99}/g,
    placeholder: "REDACTED_STRIPE_SK",
  },
  {
    name: "Stripe restricted key",
    regex: /rk_live_[A-Za-z0-9]{24,99}/g,
    placeholder: "REDACTED_STRIPE_RK",
  },

  // AWS
  {
    name: "AWS access key",
    regex: /AKIA[0-9A-Z]{16}/g,
    placeholder: "REDACTED_AWS_KEY",
  },
  {
    name: "AWS secret key",
    regex: /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*["']?([A-Za-z0-9/+=]{40})["']?/g,
    placeholder: "REDACTED_AWS_SECRET",
  },

  // Google Cloud
  {
    name: "Google API key",
    regex: /AIza[0-9A-Za-z_-]{35}/g,
    placeholder: "REDACTED_GOOGLE_API_KEY",
  },

  // Slack
  {
    name: "Slack bot token",
    regex: /xoxb-[0-9]{10,13}-[0-9]{10,13}-[a-zA-Z0-9]{24}/g,
    placeholder: "REDACTED_SLACK_TOKEN",
  },
  {
    name: "Slack webhook",
    regex: /https:\/\/hooks\.slack\.com\/services\/T[a-zA-Z0-9_]+\/B[a-zA-Z0-9_]+\/[a-zA-Z0-9_]+/g,
    placeholder: "REDACTED_SLACK_WEBHOOK",
  },

  // SendGrid
  {
    name: "SendGrid API key",
    regex: /SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/g,
    placeholder: "REDACTED_SENDGRID_KEY",
  },

  // Twilio
  {
    name: "Twilio API key",
    regex: /SK[0-9a-fA-F]{32}/g,
    placeholder: "REDACTED_TWILIO_KEY",
  },

  // Generic bearer/auth tokens
  {
    name: "Bearer token",
    regex: /(?:Bearer|bearer)\s+[A-Za-z0-9_\-.]{20,500}/g,
    placeholder: "Bearer REDACTED_TOKEN",
  },

  // Private keys (PEM format inline)
  {
    name: "Private key (PEM)",
    regex: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/g,
    placeholder: "REDACTED_PRIVATE_KEY",
  },

  // Generic secret assignment patterns — match only the quoted value
  // The regex matches keyword=<value> but the replacement preserves the
  // keyword= prefix by using a capturing group for the value portion only.
  {
    name: "Generic secret assignment",
    regex: /(?<=(?:secret|password|passwd|api_key|apikey|access_token|auth_token|private_key)\s*[=:]\s*)["']([^"'\s]{8,})["']/gi,
    placeholder: '"REDACTED_SECRET_VALUE"',
  },

  // Internal URLs (optional redaction)
  {
    name: "Internal URL",
    regex: /https?:\/\/(?:internal|staging|dev|localhost)[^\s"')>]{5,}/g,
    placeholder: "https://redacted.invalid",
  },
];

// ---------------------------------------------------------------------------
// 3. Shannon entropy threshold
// ---------------------------------------------------------------------------

/**
 * Minimum Shannon entropy per character for a string to be flagged
 * as a potential secret. Typical API keys have entropy > 4.5.
 * English text is usually ~3.5-4.0.
 */
export const ENTROPY_THRESHOLD = 4.5;

/**
 * Minimum length for entropy-based detection.
 * Short strings have unreliable entropy.
 */
export const ENTROPY_MIN_LENGTH = 16;

/**
 * Maximum length for entropy-based detection.
 * Very long strings are usually not single secrets.
 */
export const ENTROPY_MAX_LENGTH = 500;
