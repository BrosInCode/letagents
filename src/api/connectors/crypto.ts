import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

/**
 * Tracker credentials at rest: AES-256-GCM under a server key from
 * `LETAGENTS_CONNECTOR_SECRET_KEY` (32 bytes, base64 or hex). The additional
 * authenticated data binds each ciphertext to its connection and account, so a
 * row's credentials cannot be copied onto another row and still decrypt.
 *
 * Key rotation is out of scope: `credentials_version` is 1 for every row, and a
 * new key makes existing connections fail to decrypt (they then need re-auth).
 */
export const CONNECTOR_SECRET_KEY_ENV = "LETAGENTS_CONNECTOR_SECRET_KEY";
export const CONNECTOR_CREDENTIALS_VERSION = 1;

const IV_BYTES = 12;
const TAG_BYTES = 16;

export class ConnectorKeyMissingError extends Error {
  readonly code = "connector_key_missing";
  constructor(message = `${CONNECTOR_SECRET_KEY_ENV} is not set; ticket connectors are disabled on this server.`) {
    super(message);
    this.name = "ConnectorKeyMissingError";
  }
}

export class ConnectorDecryptError extends Error {
  readonly code = "connector_decrypt_failed";
  constructor() {
    // Never include ciphertext, key material or plaintext in this message.
    super("Stored tracker credentials could not be decrypted. Connect the tracker again.");
    this.name = "ConnectorDecryptError";
  }
}

export interface EncryptedCredentials {
  ciphertext: string;
  iv: string;
  version: number;
}

export interface ConnectorCipher {
  encrypt(plaintext: Record<string, unknown>, aad: CredentialBinding): EncryptedCredentials;
  decrypt(encrypted: EncryptedCredentials, aad: CredentialBinding): Record<string, unknown>;
  /**
   * The webhook signing secret of one connection: HMAC-SHA256 of the
   * connection id under the server key, so nothing extra is stored.
   */
  webhookSecret(connectionId: string): string;
}

export interface CredentialBinding {
  connection_id: string;
  account_id: string;
}

function parseKey(raw: string): Buffer {
  const value = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, "hex");
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) {
    const decoded = Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (decoded.length === 32) return decoded;
  }
  throw new ConnectorKeyMissingError(
    `${CONNECTOR_SECRET_KEY_ENV} must be 32 random bytes, as 64 hex characters or base64; ticket connectors are disabled on this server.`,
  );
}

function aadFor(binding: CredentialBinding): Buffer {
  return Buffer.from(`letagents-connector:v${CONNECTOR_CREDENTIALS_VERSION}:${binding.connection_id}:${binding.account_id}`, "utf8");
}

export function createConnectorCipher(rawKey: string): ConnectorCipher {
  const key = parseKey(rawKey);
  return {
    encrypt(plaintext, binding) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
      cipher.setAAD(aadFor(binding));
      const body = Buffer.concat([cipher.update(JSON.stringify(plaintext), "utf8"), cipher.final()]);
      return {
        ciphertext: Buffer.concat([body, cipher.getAuthTag()]).toString("base64"),
        iv: iv.toString("base64"),
        version: CONNECTOR_CREDENTIALS_VERSION,
      };
    },
    decrypt(encrypted, binding) {
      if (encrypted.version !== CONNECTOR_CREDENTIALS_VERSION) throw new ConnectorDecryptError();
      try {
        const iv = Buffer.from(encrypted.iv, "base64");
        const sealed = Buffer.from(encrypted.ciphertext, "base64");
        if (iv.length !== IV_BYTES || sealed.length <= TAG_BYTES) throw new ConnectorDecryptError();
        const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
        decipher.setAAD(aadFor(binding));
        decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
        const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)), decipher.final()]);
        const parsed = JSON.parse(plain.toString("utf8")) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ConnectorDecryptError();
        return parsed as Record<string, unknown>;
      } catch {
        throw new ConnectorDecryptError();
      }
    },
    webhookSecret(connectionId) {
      return createHmac("sha256", key).update(`letagents-connector-webhook:v1:${connectionId}`, "utf8").digest("hex");
    },
  };
}

/**
 * The server's connector cipher, or null when the key is missing or invalid.
 * Connector routes answer 503 while this is null; nothing else depends on it.
 */
export function loadConnectorCipher(env: NodeJS.ProcessEnv = process.env): ConnectorCipher | null {
  const raw = env[CONNECTOR_SECRET_KEY_ENV];
  if (!raw?.trim()) return null;
  try {
    return createConnectorCipher(raw);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid connector secret key.");
    return null;
  }
}

/** Placeholders for any credential value that reaches an error message. */
export function redactConnectorSecrets(text: string, secrets: ReadonlyArray<string | null | undefined> = []): string {
  let result = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 6) result = result.split(secret).join("[REDACTED]");
  }
  return result
    .replace(/ATATT[A-Za-z0-9_\-=]{20,}/g, "REDACTED_ATLASSIAN_TOKEN")
    .replace(/lin_(?:api|oauth)_[A-Za-z0-9]{20,}/g, "REDACTED_LINEAR_TOKEN")
    .replace(/(?:Bearer|Basic)\s+[A-Za-z0-9_\-.=+/]{12,}/g, "REDACTED_AUTHORIZATION")
    .replace(/("?(?:access_token|refresh_token|client_secret|api_token|api_key)"?\s*[:=]\s*"?)[^"\s,}&]+/gi, "$1[REDACTED]");
}
