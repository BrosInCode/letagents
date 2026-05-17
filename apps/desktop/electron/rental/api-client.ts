/**
 * Desktop-side Rent an Agent API client (p1.8a).
 *
 * Wraps `fetch` against the LetAgents REST endpoints with a typed
 * surface the IPC handlers can call without each one re-implementing
 * URL composition, auth, error mapping, and JSON parsing.
 *
 * Scope of this slice:
 *   • Read methods for the renter + provider surfaces that the
 *     desktop renderer needs to populate dashboards
 *     (list listings, list provider requests, get session, get
 *      activity, get usage).
 *   • Mutating methods for the in-app provider flow (create /
 *     update / pause / resume listing, accept / decline request,
 *     cancel session, heartbeat, declare quota exhausted, get
 *     own quota status).
 *   • Renter-side session create.
 *
 * What this module deliberately does NOT do (lands in p1.8b/c):
 *   • Replace stubs in `rental-handlers.ts`. The IPC handlers in
 *     this version of the desktop still return their stub shapes.
 *     This client is the building block that p1.8b wires in.
 *   • Map API row shapes into `DesktopRental*` payloads. Mapping
 *     is a separate concern handled in the next slice so this
 *     client can be exercised by either renderer-facing code or
 *     server-shape consumers like the rental MCP bridge.
 *
 * The client returns one of two outcomes for every call:
 *   { ok: true,  status, body }                 — JSON parsed
 *   { ok: false, status, error, body }          — HTTP/parse error
 *
 * Network failures and bodies that fail JSON.parse are surfaced
 * as `{ ok: false, status: 0, error }` so the IPC handler can
 * decide whether to fall back to a "rent_unreachable" stub or
 * propagate.
 *
 * Spec refs:
 *   §6   provider listing + accept flow
 *   §7   renter session creation
 *   §18  session lifecycle endpoints
 *   §19  rental_sessions / rental_listings shape
 *
 * Plan: docs/RENT_AN_AGENT_TASK_BREAKDOWN.md PR p1.8 (split into
 * p1.8a = client, p1.8b = mapper, p1.8c = handler wiring).
 */

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

/**
 * Discriminated result type. `ok` is the discriminator; readers
 * check `if (result.ok)` to access `body` safely.
 */
export type RentalApiResult<T> =
  | { ok: true; status: number; body: T }
  | {
      ok: false;
      status: number;
      error: string;
      /** Raw parsed body if the server returned one, else null. */
      body: unknown;
    };

// ---------------------------------------------------------------------------
// Config / construction
// ---------------------------------------------------------------------------

export type FetchLike = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export interface RentalApiClientOptions {
  /** Base API URL, e.g. `https://letagents.chat`. Trailing slash optional. */
  apiBaseUrl: string;
  /**
   * Bearer token to send as `Authorization: Bearer <token>`. When
   * omitted the request goes unauthenticated; the server returns
   * 401 and the client surfaces that verbatim.
   *
   * Mutually exclusive with `getAuthToken`. When both are
   * provided, `getAuthToken` wins.
   */
  authToken?: string | null;
  /**
   * Dynamic auth-token resolver. Called once per request, so the
   * token can change across the client's lifetime (user signs in,
   * signs out, token refresh, etc.) without rebuilding the
   * client. Sync or async; returning null / undefined / empty
   * sends the request unauthenticated.
   */
  getAuthToken?: () => string | null | undefined | Promise<string | null | undefined>;
  /**
   * Override `fetch` for tests. Defaults to `globalThis.fetch`.
   */
  fetchFn?: FetchLike;
  /**
   * Override the global JSON parsing for tests / introspection.
   * Defaults to `JSON.parse`.
   */
  parseJson?: (text: string) => unknown;
}

export class RentalApiClient {
  private readonly apiBaseUrl: string;
  private readonly authToken: string | null;
  private readonly getAuthToken: RentalApiClientOptions["getAuthToken"];
  private readonly fetchFn: FetchLike;
  private readonly parseJson: (text: string) => unknown;

  constructor(options: RentalApiClientOptions) {
    this.apiBaseUrl = options.apiBaseUrl.replace(/\/+$/, "");
    this.authToken = options.authToken?.trim() || null;
    this.getAuthToken = options.getAuthToken;
    this.fetchFn = options.fetchFn ?? (globalThis.fetch as FetchLike);
    this.parseJson = options.parseJson ?? JSON.parse;
  }

  private async resolveAuthToken(): Promise<string | null> {
    if (this.getAuthToken) {
      const value = await this.getAuthToken();
      if (typeof value === "string") {
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : null;
      }
      return null;
    }
    return this.authToken;
  }

  // -------------------------------------------------------------------------
  // Listings — public discovery + provider CRUD
  // -------------------------------------------------------------------------

  publicListings(filters: {
    ideKind?: string;
    modelLabel?: string;
    mode?: "scoped" | "trusted_open";
    limit?: number;
    offset?: number;
  } = {}): Promise<RentalApiResult<unknown>> {
    const q = new URLSearchParams();
    if (filters.ideKind) q.set("ide_kind", filters.ideKind);
    if (filters.modelLabel) q.set("model_label", filters.modelLabel);
    if (filters.mode) q.set("mode", filters.mode);
    if (typeof filters.limit === "number") q.set("limit", String(filters.limit));
    if (typeof filters.offset === "number") q.set("offset", String(filters.offset));
    const suffix = q.toString();
    return this.request<unknown>(
      "GET",
      `/api/rental/listings${suffix ? `?${suffix}` : ""}`,
    );
  }

  listProviderListings(): Promise<RentalApiResult<unknown>> {
    return this.request<unknown>("GET", "/api/rental/provider/listings");
  }

  createListing(input: Record<string, unknown>): Promise<RentalApiResult<unknown>> {
    return this.request<unknown>("POST", "/api/rental/provider/listings", input);
  }

  updateListing(
    listingId: string,
    patch: Record<string, unknown>,
  ): Promise<RentalApiResult<unknown>> {
    return this.request<unknown>(
      "PATCH",
      `/api/rental/provider/listings/${encodeURIComponent(listingId)}`,
      patch,
    );
  }

  pauseListing(listingId: string): Promise<RentalApiResult<unknown>> {
    return this.request<unknown>(
      "POST",
      `/api/rental/provider/listings/${encodeURIComponent(listingId)}/pause`,
    );
  }

  resumeListing(listingId: string): Promise<RentalApiResult<unknown>> {
    return this.request<unknown>(
      "POST",
      `/api/rental/provider/listings/${encodeURIComponent(listingId)}/resume`,
    );
  }

  /**
   * p2.15 — read the provider-level readiness rollup for the
   * authenticated provider. Server projects all of the caller's
   * listings into a single `ApiProviderReadiness` (status + summary
   * + blockers/warnings/badges + per-listing checks).
   *
   * Companion mapper: `mapApiProviderReadiness` in `api-mapper.ts`.
   */
  getProviderReadiness(): Promise<RentalApiResult<unknown>> {
    return this.request<unknown>("GET", "/api/rental/provider/readiness");
  }

  // -------------------------------------------------------------------------
  // Sessions — provider requests + renter create + lifecycle
  // -------------------------------------------------------------------------

  listProviderRequests(): Promise<RentalApiResult<unknown>> {
    return this.request<unknown>("GET", "/api/rental/provider/requests");
  }

  acceptRequest(
    sessionId: string,
    body: Record<string, unknown> = {},
  ): Promise<RentalApiResult<unknown>> {
    return this.request<unknown>(
      "POST",
      `/api/rental/provider/sessions/${encodeURIComponent(sessionId)}/accept`,
      body,
    );
  }

  declineRequest(
    sessionId: string,
    body: Record<string, unknown> = {},
  ): Promise<RentalApiResult<unknown>> {
    return this.request<unknown>(
      "POST",
      `/api/rental/provider/sessions/${encodeURIComponent(sessionId)}/decline`,
      body,
    );
  }

  createSession(input: Record<string, unknown>): Promise<RentalApiResult<unknown>> {
    return this.request<unknown>("POST", "/api/rental/sessions", input);
  }

  getSession(sessionId: string): Promise<RentalApiResult<unknown>> {
    return this.request<unknown>(
      "GET",
      `/api/rental/sessions/${encodeURIComponent(sessionId)}`,
    );
  }

  cancelSession(
    sessionId: string,
    body: Record<string, unknown> = {},
  ): Promise<RentalApiResult<unknown>> {
    return this.request<unknown>(
      "POST",
      `/api/rental/sessions/${encodeURIComponent(sessionId)}/cancel`,
      body,
    );
  }

  /**
   * p2.10a — read activity events visible to the caller's role on a
   * session. Caller role is decided server-side from the session row;
   * we just hand the API a session id and optional pagination knobs.
   *
   * Returns `{ events: [...] }` on success. The desktop `api-mapper`
   * exposes `mapApiActivityEventArray` for converting the rows.
   */
  getSessionActivity(
    sessionId: string,
    opts: { limit?: number; verifiedOnly?: boolean } = {},
  ): Promise<RentalApiResult<unknown>> {
    const q = new URLSearchParams();
    if (typeof opts.limit === "number" && Number.isFinite(opts.limit)) {
      q.set("limit", String(Math.max(1, Math.floor(opts.limit))));
    }
    if (opts.verifiedOnly) q.set("verified_only", "true");
    const suffix = q.toString();
    return this.request<unknown>(
      "GET",
      `/api/rental/sessions/${encodeURIComponent(sessionId)}/activity${suffix ? `?${suffix}` : ""}`,
    );
  }

  /**
   * p2.11a — read the projected usage snapshot for a session. The
   * server projects the session row directly into the snapshot
   * shape (no extra DB read), so this is cheap to poll. Auth is
   * gated server-side: the route only returns 200 when the caller
   * is the renter or the provider on the session.
   *
   * The desktop `api-mapper` exposes `mapApiUsageSnapshot` for
   * converting the wire shape into a `DesktopRentalUsageSnapshot`.
   */
  getSessionUsage(sessionId: string): Promise<RentalApiResult<unknown>> {
    return this.request<unknown>(
      "GET",
      `/api/rental/sessions/${encodeURIComponent(sessionId)}/usage`,
    );
  }

  // -------------------------------------------------------------------------
  // Internal (provider liveness + adapter snapshot ingest)
  // -------------------------------------------------------------------------

  heartbeat(sessionId: string): Promise<RentalApiResult<unknown>> {
    return this.request<unknown>(
      "POST",
      `/api/rental/sessions/${encodeURIComponent(sessionId)}/heartbeat`,
    );
  }

  liveness(sessionId: string): Promise<RentalApiResult<unknown>> {
    return this.request<unknown>(
      "GET",
      `/api/rental/sessions/${encodeURIComponent(sessionId)}/liveness`,
    );
  }

  reportUsage(
    sessionId: string,
    report: Record<string, unknown>,
  ): Promise<RentalApiResult<unknown>> {
    return this.request<unknown>(
      "POST",
      `/api/rental/sessions/${encodeURIComponent(sessionId)}/usage`,
      report,
    );
  }

  // -------------------------------------------------------------------------
  // Renter-side quota status mirror (#384)
  // -------------------------------------------------------------------------

  renterQuotaStatus(): Promise<RentalApiResult<unknown>> {
    return this.request<unknown>("GET", "/api/rental/renter/quota-status");
  }

  declareQuotaExhausted(
    input: Record<string, unknown>,
  ): Promise<RentalApiResult<unknown>> {
    return this.request<unknown>(
      "POST",
      "/api/rental/renter/declare-quota-exhausted",
      input,
    );
  }

  // -------------------------------------------------------------------------
  // Core HTTP plumbing
  // -------------------------------------------------------------------------

  /**
   * Generic dispatcher. Methods above are thin URL/body wrappers
   * over this. Public for use by future endpoints not yet wrapped
   * here — but keep the wrappers as the canonical surface so the
   * shape catalog stays discoverable in this module.
   */
  async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown> | null,
  ): Promise<RentalApiResult<T>> {
    const url = `${this.apiBaseUrl}${path}`;
    const headers: Record<string, string> = {
      accept: "application/json",
    };
    let serializedBody: string | undefined;
    if (body !== undefined && body !== null) {
      headers["content-type"] = "application/json";
      serializedBody = JSON.stringify(body);
    }
    const resolvedToken = await this.resolveAuthToken();
    if (resolvedToken) {
      headers.authorization = `Bearer ${resolvedToken}`;
    }

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method,
        headers,
        body: serializedBody,
      });
    } catch (err) {
      return {
        ok: false,
        status: 0,
        error: err instanceof Error ? err.message : String(err),
        body: null,
      };
    }

    let text = "";
    try {
      text = await response.text();
    } catch {
      text = "";
    }

    let parsed: unknown = null;
    if (text) {
      try {
        parsed = this.parseJson(text);
      } catch {
        // Non-JSON server response — surface as a parse error
        // result so callers can still log the raw text.
        return {
          ok: false,
          status: response.status,
          error: "response_not_json",
          body: text,
        };
      }
    }

    if (!response.ok) {
      const error = readError(parsed) ?? `http_${response.status}`;
      return {
        ok: false,
        status: response.status,
        error,
        body: parsed,
      };
    }

    return {
      ok: true,
      status: response.status,
      body: parsed as T,
    };
  }
}

function readError(parsed: unknown): string | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.error === "string") return obj.error;
  if (typeof obj.code === "string") return obj.code;
  return null;
}
