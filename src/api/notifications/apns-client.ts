import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect, constants, type ClientHttp2Session, type IncomingHttpHeaders } from "node:http2";

export type ApnsEnvironment = "production" | "sandbox";

export interface ApnsNotificationInput {
  notificationId: string;
  deviceToken: string;
  environment: ApnsEnvironment;
  roomId: string;
  roomDisplayName: string;
  messageId: string;
  threadRootId: string | null;
  sender: string;
  body: string;
}

export interface ApnsSendResult {
  status: number;
  reason: string | null;
  apnsId: string | null;
}

export interface ApnsCredentials {
  teamId: string;
  keyId: string;
  privateKey: string;
  topic: string;
}

export function shouldRefreshApnsProviderToken(result: Pick<ApnsSendResult, "status">): boolean {
  return result.status === 403;
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function normalizePrivateKey(value: string): string {
  return value.includes("\\n") ? value.replace(/\\n/g, "\n") : value;
}

export function readApnsCredentials(env: NodeJS.ProcessEnv = process.env): ApnsCredentials | null {
  const teamId = env.APNS_TEAM_ID?.trim();
  const keyId = env.APNS_KEY_ID?.trim();
  const topic = env.APNS_TOPIC?.trim() || "chat.letagents.desktop";
  const inlinePrivateKey = env.APNS_PRIVATE_KEY?.trim();
  const privateKeyPath = env.APNS_PRIVATE_KEY_PATH?.trim();
  if (!teamId || !keyId || (!inlinePrivateKey && !privateKeyPath)) return null;
  const privateKey = normalizePrivateKey(inlinePrivateKey || readFileSync(privateKeyPath!, "utf8"));
  return { teamId, keyId, privateKey, topic };
}

export function createApnsProviderToken(credentials: ApnsCredentials, issuedAt = Math.floor(Date.now() / 1000)): string {
  const encodedHeader = base64Url(JSON.stringify({ alg: "ES256", kid: credentials.keyId }));
  const encodedClaims = base64Url(JSON.stringify({ iss: credentials.teamId, iat: issuedAt }));
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const signer = createSign("SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign({ key: credentials.privateKey, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${base64Url(signature)}`;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (Buffer.byteLength(clean) <= maxBytes) return clean;
  let result = clean;
  while (result && Buffer.byteLength(`${result}…`) > maxBytes) result = result.slice(0, -1);
  return `${result.trimEnd()}…`;
}

export function buildApnsPayload(input: ApnsNotificationInput): Record<string, unknown> {
  const sender = input.sender.split("|")[0]?.trim() || "LetAgents";
  return {
    aps: {
      alert: {
        title: `${sender} in ${truncateUtf8(input.roomDisplayName, 120)}`,
        body: truncateUtf8(input.body, 1_800) || "Sent an attachment",
      },
      sound: "default",
      "thread-id": input.roomId,
    },
    letagents: {
      notification_id: input.notificationId,
      room_id: input.roomId,
      message_id: input.messageId,
      thread_root_id: input.threadRootId,
    },
  };
}

function apnsOrigin(environment: ApnsEnvironment): string {
  return environment === "sandbox"
    ? "https://api.sandbox.push.apple.com"
    : "https://api.push.apple.com";
}

export class ApnsClient {
  private readonly sessions = new Map<ApnsEnvironment, ClientHttp2Session>();
  private token: { value: string; issuedAt: number } | null = null;

  constructor(private readonly credentials: ApnsCredentials) {}

  private providerToken(): string {
    const now = Math.floor(Date.now() / 1000);
    if (!this.token || now - this.token.issuedAt >= 50 * 60) {
      this.token = { value: createApnsProviderToken(this.credentials, now), issuedAt: now };
    }
    return this.token.value;
  }

  private session(environment: ApnsEnvironment): ClientHttp2Session {
    const existing = this.sessions.get(environment);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const session = connect(apnsOrigin(environment));
    session.on("error", () => this.sessions.delete(environment));
    session.on("close", () => this.sessions.delete(environment));
    session.on("goaway", () => this.sessions.delete(environment));
    this.sessions.set(environment, session);
    return session;
  }

  async send(input: ApnsNotificationInput): Promise<ApnsSendResult> {
    const payload = JSON.stringify(buildApnsPayload(input));
    if (Buffer.byteLength(payload) > 4_096) {
      throw new Error("APNs payload exceeds 4096 bytes");
    }

    return new Promise<ApnsSendResult>((resolve, reject) => {
      const request = this.session(input.environment).request({
        [constants.HTTP2_HEADER_METHOD]: "POST",
        [constants.HTTP2_HEADER_PATH]: `/3/device/${input.deviceToken}`,
        authorization: `bearer ${this.providerToken()}`,
        "apns-topic": this.credentials.topic,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-expiration": String(Math.floor(Date.now() / 1000) + 24 * 60 * 60),
        "apns-collapse-id": input.notificationId,
      });
      let responseHeaders: IncomingHttpHeaders = {};
      const chunks: Buffer[] = [];
      let responseBytes = 0;
      let settled = false;
      const rejectOnce = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      request.setEncoding("utf8");
      request.setTimeout(20_000, () => {
        request.close(constants.NGHTTP2_CANCEL);
        rejectOnce(new Error("APNs request timed out after 20000 ms"));
      });
      request.on("response", (headers) => { responseHeaders = headers; });
      request.on("data", (chunk: string) => {
        const bytes = Buffer.from(chunk);
        responseBytes += bytes.length;
        if (responseBytes <= 64 * 1024) chunks.push(bytes);
      });
      request.on("error", rejectOnce);
      request.on("end", () => {
        if (settled) return;
        settled = true;
        const status = Number(responseHeaders[constants.HTTP2_HEADER_STATUS] || 0);
        const responseBody = Buffer.concat(chunks).toString("utf8");
        let reason: string | null = null;
        if (responseBody) {
          try {
            const parsed = JSON.parse(responseBody) as { reason?: unknown };
            reason = typeof parsed.reason === "string" ? parsed.reason : null;
          } catch {
            reason = responseBody.slice(0, 240);
          }
        }
        const apnsIdHeader = responseHeaders["apns-id"];
        const result = {
          status,
          reason,
          apnsId: typeof apnsIdHeader === "string" ? apnsIdHeader : null,
        };
        if (shouldRefreshApnsProviderToken(result)) this.token = null;
        resolve(result);
      });
      request.end(payload);
    });
  }

  close(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }
}
