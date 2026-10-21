import { redactConnectorSecrets } from "../crypto.js";
import { TrackerProviderError } from "./types.js";

export const TRACKER_REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2_000_000;

export interface TrackerRequest {
  url: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  body?: unknown;
  form?: Record<string, string>;
  /** Secret values to scrub from any error text. */
  secrets?: ReadonlyArray<string | null | undefined>;
  /** Whether the request writes: transport failures are then ambiguous. */
  write?: boolean;
}

export interface TrackerResponse {
  status: number;
  json: unknown;
}

/**
 * One HTTPS request to a tracker. Redirects are refused (a redirect could
 * carry the Authorization header to another host), responses are size-bounded,
 * and error text is scrubbed of the request's secrets.
 */
export async function trackerRequest(
  fetchImpl: typeof fetch,
  request: TrackerRequest,
  timeoutMs = TRACKER_REQUEST_TIMEOUT_MS,
): Promise<TrackerResponse> {
  const url = new URL(request.url);
  if (url.protocol !== "https:") throw new TrackerProviderError("definite", "Tracker requests must use https.");
  const headers: Record<string, string> = { Accept: "application/json", "User-Agent": "letagents", ...request.headers };
  let body: string | undefined;
  if (request.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(request.form).toString();
  } else if (request.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(request.body);
  }
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: request.method ?? "GET",
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const message = redactConnectorSecrets(error instanceof Error ? error.message : "request failed", request.secrets);
    throw new TrackerProviderError(
      request.write ? "ambiguous" : "definite",
      `Tracker request to ${url.host} failed: ${message}`,
    );
  }
  if (response.status >= 300 && response.status < 400) {
    throw new TrackerProviderError("definite", `Tracker at ${url.host} answered with a redirect; redirects are not followed.`, response.status);
  }
  const text = await readBounded(response, request.write === true && response.ok);
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (!response.ok) {
    const detail = redactConnectorSecrets(text.slice(0, 500), request.secrets);
    // A 5xx on a write may still have committed, so only a lookup may follow.
    // A 4xx (429 included) was refused before any change.
    const outcome = response.status === 401
      ? "auth"
      : response.status >= 500 && request.write
        ? "ambiguous"
        : "definite";
    throw new TrackerProviderError(outcome, `Tracker at ${url.host} answered ${response.status}${detail ? `: ${detail}` : ""}`, response.status);
  }
  return { status: response.status, json };
}

/** The body, up to a bound. Past it, an accepted write is ambiguous, not refused. */
async function readBounded(response: Response, acceptedWrite = false): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new TrackerProviderError(acceptedWrite ? "ambiguous" : "definite", "Tracker response was too large.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
