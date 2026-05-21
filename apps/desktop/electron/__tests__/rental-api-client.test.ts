/**
 * Tests for the desktop-side RentalApiClient (p1.8a).
 *
 * Covers:
 *   - URL composition: base URL trim, query strings, path encoding
 *   - HTTP verbs: GET / POST / PATCH on the right endpoints
 *   - Auth header: present when authToken provided, absent otherwise
 *   - Request body: omitted for GET, JSON-encoded for POST/PATCH
 *   - Response: ok=true + parsed body on 2xx + JSON
 *   - Response: ok=false + error string on 4xx/5xx, reads `error` /
 *     `code` from server payload
 *   - Network failure surfaces as { ok: false, status: 0, error }
 *   - Non-JSON server response surfaces as response_not_json with
 *     raw text in `body`
 *   - listings: query params formatted correctly (snake_case keys)
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  RentalApiClient,
  type FetchLike,
  type RentalApiResult,
} from "../rental/api-client.js";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface FetchCall {
  url: string;
  init: RequestInit;
}

function makeFetchHarness(
  responder: (url: string, init: RequestInit) => {
    status?: number;
    body?: unknown;
    raw?: string;
    error?: Error;
  } | Promise<{ status?: number; body?: unknown; raw?: string; error?: Error }>,
): { fetchFn: FetchLike; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const r = await responder(url, init);
    if (r.error) throw r.error;
    const status = r.status ?? 200;
    const text =
      r.raw !== undefined
        ? r.raw
        : r.body === undefined
          ? ""
          : JSON.stringify(r.body);
    return new Response(text, {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchFn, calls };
}

function makeClient(opts: {
  authToken?: string | null;
  fetchFn: FetchLike;
}): RentalApiClient {
  return new RentalApiClient({
    apiBaseUrl: "https://letagents.chat/", // trailing slash to exercise trim
    authToken: opts.authToken,
    fetchFn: opts.fetchFn,
  });
}

function expectOk<T>(result: RentalApiResult<T>): T {
  if (!result.ok) {
    throw new Error(
      `expected ok result, got status=${result.status} error=${result.error}`,
    );
  }
  return result.body;
}

// ---------------------------------------------------------------------------
// URL composition + auth
// ---------------------------------------------------------------------------

describe("URL composition + auth header", () => {
  it("trims trailing slash from apiBaseUrl + composes the full URL", async () => {
    const { fetchFn, calls } = makeFetchHarness(() => ({ body: { listings: [] } }));
    const client = makeClient({ fetchFn });
    await client.listProviderListings();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://letagents.chat/api/rental/provider/listings");
  });

  it("URL-encodes path segments (session ids, listing ids)", async () => {
    const { fetchFn, calls } = makeFetchHarness(() => ({ body: { id: "x" } }));
    const client = makeClient({ fetchFn });
    await client.getSession("rsess/with weird?chars");
    assert.equal(
      calls[0].url,
      "https://letagents.chat/api/rental/sessions/rsess%2Fwith%20weird%3Fchars",
    );
  });

  it("attaches Authorization Bearer header when authToken is provided", async () => {
    const { fetchFn, calls } = makeFetchHarness(() => ({ body: {} }));
    const client = makeClient({ fetchFn, authToken: "lt_abc_123" });
    await client.listProviderListings();
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers.authorization, "Bearer lt_abc_123");
  });

  it("omits Authorization when authToken is missing or blank", async () => {
    const { fetchFn, calls } = makeFetchHarness(() => ({ body: {} }));
    const client = makeClient({ fetchFn, authToken: "  " });
    await client.listProviderListings();
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers.authorization, undefined);
  });

  it("resolves the auth token from a sync getAuthToken on each request", async () => {
    const { fetchFn, calls } = makeFetchHarness(() => ({ body: {} }));
    let tokens = ["token_a", "token_b", "token_c"];
    let i = 0;
    const client = new RentalApiClient({
      apiBaseUrl: "https://letagents.chat",
      fetchFn,
      getAuthToken: () => tokens[i++] ?? null,
    });
    await client.listProviderListings();
    await client.listProviderListings();
    await client.listProviderListings();
    assert.equal(
      (calls[0].init.headers as Record<string, string>).authorization,
      "Bearer token_a",
    );
    assert.equal(
      (calls[1].init.headers as Record<string, string>).authorization,
      "Bearer token_b",
    );
    assert.equal(
      (calls[2].init.headers as Record<string, string>).authorization,
      "Bearer token_c",
    );
  });

  it("resolves async getAuthToken (Promise<string>)", async () => {
    const { fetchFn, calls } = makeFetchHarness(() => ({ body: {} }));
    const client = new RentalApiClient({
      apiBaseUrl: "https://letagents.chat",
      fetchFn,
      getAuthToken: async () => "lt_dyn_xyz",
    });
    await client.listProviderListings();
    assert.equal(
      (calls[0].init.headers as Record<string, string>).authorization,
      "Bearer lt_dyn_xyz",
    );
  });

  it("getAuthToken returning null / undefined / blank omits Authorization", async () => {
    const { fetchFn, calls } = makeFetchHarness(() => ({ body: {} }));
    const client = new RentalApiClient({
      apiBaseUrl: "https://letagents.chat",
      fetchFn,
      getAuthToken: () => null,
    });
    await client.listProviderListings();
    assert.equal((calls[0].init.headers as Record<string, string>).authorization, undefined);

    const blank = makeFetchHarness(() => ({ body: {} }));
    const client2 = new RentalApiClient({
      apiBaseUrl: "https://letagents.chat",
      fetchFn: blank.fetchFn,
      getAuthToken: () => "   ",
    });
    await client2.listProviderListings();
    assert.equal(
      (blank.calls[0].init.headers as Record<string, string>).authorization,
      undefined,
    );
  });

  it("getAuthToken wins over a static authToken when both are provided", async () => {
    const { fetchFn, calls } = makeFetchHarness(() => ({ body: {} }));
    const client = new RentalApiClient({
      apiBaseUrl: "https://letagents.chat",
      fetchFn,
      authToken: "static_token",
      getAuthToken: () => "dynamic_token",
    });
    await client.listProviderListings();
    assert.equal(
      (calls[0].init.headers as Record<string, string>).authorization,
      "Bearer dynamic_token",
    );
  });
});

// ---------------------------------------------------------------------------
// Verbs + body handling
// ---------------------------------------------------------------------------

describe("HTTP verb + body", () => {
  it("GET requests do not set content-type and do not send a body", async () => {
    const { fetchFn, calls } = makeFetchHarness(() => ({ body: [] }));
    const client = makeClient({ fetchFn });
    await client.listProviderListings();
    assert.equal(calls[0].init.method, "GET");
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers["content-type"], undefined);
    assert.equal(calls[0].init.body, undefined);
  });

  it("POST requests JSON-encode the body and set content-type", async () => {
    const { fetchFn, calls } = makeFetchHarness(() => ({
      status: 201,
      body: { id: "listing_1" },
    }));
    const client = makeClient({ fetchFn });
    await client.createListing({
      displayName: "My agent",
      ideKind: "antigravity",
    });
    assert.equal(calls[0].init.method, "POST");
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
      displayName: "My agent",
      ideKind: "antigravity",
    });
  });

  it("PATCH requests follow the same body shape", async () => {
    const { fetchFn, calls } = makeFetchHarness(() => ({ body: { id: "listing_1" } }));
    const client = makeClient({ fetchFn });
    await client.updateListing("listing_1", { displayName: "Renamed" });
    assert.equal(calls[0].init.method, "PATCH");
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
      displayName: "Renamed",
    });
  });

  it("acceptRequest sends an empty body by default but accepts an idempotency_key payload", async () => {
    const { fetchFn, calls } = makeFetchHarness(() => ({ body: { id: "rsess_1" } }));
    const client = makeClient({ fetchFn });
    await client.acceptRequest("rsess_1");
    // Default {} payload still serializes (we send "{}").
    assert.equal(calls[0].init.body, "{}");

    await client.acceptRequest("rsess_1", { idempotency_key: "key-1" });
    assert.deepEqual(JSON.parse(String(calls[1].init.body)), {
      idempotency_key: "key-1",
    });
  });
});

// ---------------------------------------------------------------------------
// Listings query params
// ---------------------------------------------------------------------------

describe("publicListings query params", () => {
  it("only adds set filters and uses snake_case keys", async () => {
    const { fetchFn, calls } = makeFetchHarness(() => ({
      body: { listings: [], filters: {} },
    }));
    const client = makeClient({ fetchFn });
    await client.publicListings({
      ideKind: "antigravity",
      mode: "scoped",
      limit: 25,
    });
    const url = new URL(calls[0].url);
    assert.equal(url.pathname, "/api/rental/listings");
    assert.equal(url.searchParams.get("ide_kind"), "antigravity");
    assert.equal(url.searchParams.get("mode"), "scoped");
    assert.equal(url.searchParams.get("limit"), "25");
    assert.equal(url.searchParams.has("model_label"), false);
    assert.equal(url.searchParams.has("offset"), false);
  });

  it("omits the query string entirely when no filters are passed", async () => {
    const { fetchFn, calls } = makeFetchHarness(() => ({
      body: { listings: [], filters: {} },
    }));
    const client = makeClient({ fetchFn });
    await client.publicListings();
    assert.equal(calls[0].url, "https://letagents.chat/api/rental/listings");
  });
});

// ---------------------------------------------------------------------------
// Response handling — happy path + errors
// ---------------------------------------------------------------------------

describe("response handling", () => {
  it("parses JSON body on 2xx into result.body", async () => {
    const { fetchFn } = makeFetchHarness(() => ({
      status: 200,
      body: { listings: [{ id: "listing_1" }] },
    }));
    const client = makeClient({ fetchFn });
    const result = await client.listProviderListings();
    const body = expectOk(result) as { listings: { id: string }[] };
    assert.equal(body.listings[0].id, "listing_1");
  });

  it("surfaces the server's `error` string from 4xx payloads", async () => {
    const { fetchFn } = makeFetchHarness(() => ({
      status: 404,
      body: { error: "listing_not_found" },
    }));
    const client = makeClient({ fetchFn });
    const result = await client.updateListing("missing", { displayName: "x" });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 404);
    assert.equal(result.error, "listing_not_found");
  });

  it("surfaces the server's `code` field when no `error` is present", async () => {
    const { fetchFn } = makeFetchHarness(() => ({
      status: 409,
      body: { code: "rent_disabled" },
    }));
    const client = makeClient({ fetchFn });
    const result = await client.listProviderListings();
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, "rent_disabled");
  });

  it("falls back to http_<status> when the error body has neither field", async () => {
    const { fetchFn } = makeFetchHarness(() => ({
      status: 500,
      body: { message: "boom" },
    }));
    const client = makeClient({ fetchFn });
    const result = await client.listProviderListings();
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, "http_500");
  });

  it("falls back to http_<status> when the body is empty", async () => {
    const { fetchFn } = makeFetchHarness(() => ({ status: 502, raw: "" }));
    const client = makeClient({ fetchFn });
    const result = await client.listProviderListings();
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, "http_502");
    assert.equal(result.body, null);
  });

  it("network failure → ok=false, status=0, error from thrown message", async () => {
    const { fetchFn } = makeFetchHarness(() => ({ error: new Error("ECONNRESET") }));
    const client = makeClient({ fetchFn });
    const result = await client.listProviderListings();
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 0);
    assert.match(result.error, /ECONNRESET/);
  });

  it("non-JSON server response → response_not_json with raw text in body", async () => {
    const { fetchFn } = makeFetchHarness(() => ({ status: 200, raw: "not json" }));
    const client = makeClient({ fetchFn });
    const result = await client.listProviderListings();
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, "response_not_json");
    assert.equal(result.body, "not json");
  });
});

// ---------------------------------------------------------------------------
// Endpoint coverage — quick sanity on each wrapper hits the right URL+verb
// ---------------------------------------------------------------------------

describe("endpoint URL + verb sanity", () => {
  it("covers every documented endpoint with the right method", async () => {
    const expectations: Array<{
      label: string;
      run: (c: RentalApiClient) => Promise<RentalApiResult<unknown>>;
      method: string;
      pathPattern: RegExp;
    }> = [
      {
        label: "publicListings",
        run: (c) => c.publicListings(),
        method: "GET",
        pathPattern: /\/api\/rental\/listings$/,
      },
      {
        label: "listProviderListings",
        run: (c) => c.listProviderListings(),
        method: "GET",
        pathPattern: /\/api\/rental\/provider\/listings$/,
      },
      {
        label: "createListing",
        run: (c) => c.createListing({}),
        method: "POST",
        pathPattern: /\/api\/rental\/provider\/listings$/,
      },
      {
        label: "updateListing",
        run: (c) => c.updateListing("listing_1", {}),
        method: "PATCH",
        pathPattern: /\/api\/rental\/provider\/listings\/listing_1$/,
      },
      {
        label: "pauseListing",
        run: (c) => c.pauseListing("listing_1"),
        method: "POST",
        pathPattern: /\/api\/rental\/provider\/listings\/listing_1\/pause$/,
      },
      {
        label: "resumeListing",
        run: (c) => c.resumeListing("listing_1"),
        method: "POST",
        pathPattern: /\/api\/rental\/provider\/listings\/listing_1\/resume$/,
      },
      {
        label: "listProviderRequests",
        run: (c) => c.listProviderRequests(),
        method: "GET",
        pathPattern: /\/api\/rental\/provider\/requests$/,
      },
      {
        label: "acceptRequest",
        run: (c) => c.acceptRequest("rsess_1"),
        method: "POST",
        pathPattern: /\/api\/rental\/provider\/sessions\/rsess_1\/accept$/,
      },
      {
        label: "declineRequest",
        run: (c) => c.declineRequest("rsess_1"),
        method: "POST",
        pathPattern: /\/api\/rental\/provider\/sessions\/rsess_1\/decline$/,
      },
      {
        label: "createSession",
        run: (c) => c.createSession({}),
        method: "POST",
        pathPattern: /\/api\/rental\/sessions$/,
      },
      {
        label: "getSession",
        run: (c) => c.getSession("rsess_1"),
        method: "GET",
        pathPattern: /\/api\/rental\/sessions\/rsess_1$/,
      },
      {
        label: "cancelSession",
        run: (c) => c.cancelSession("rsess_1"),
        method: "POST",
        pathPattern: /\/api\/rental\/sessions\/rsess_1\/cancel$/,
      },
      {
        label: "heartbeat",
        run: (c) => c.heartbeat("rsess_1"),
        method: "POST",
        pathPattern: /\/api\/rental\/sessions\/rsess_1\/heartbeat$/,
      },
      {
        label: "liveness",
        run: (c) => c.liveness("rsess_1"),
        method: "GET",
        pathPattern: /\/api\/rental\/sessions\/rsess_1\/liveness$/,
      },
      {
        label: "reportUsage",
        run: (c) => c.reportUsage("rsess_1", {}),
        method: "POST",
        pathPattern: /\/api\/rental\/sessions\/rsess_1\/usage$/,
      },
      {
        label: "renterQuotaStatus",
        run: (c) => c.renterQuotaStatus(),
        method: "GET",
        pathPattern: /\/api\/rental\/renter\/quota-status$/,
      },
      {
        label: "declareQuotaExhausted",
        run: (c) => c.declareQuotaExhausted({}),
        method: "POST",
        pathPattern: /\/api\/rental\/renter\/declare-quota-exhausted$/,
      },
      {
        label: "getPatches",
        run: (c) => c.getPatches("rsess_1"),
        method: "GET",
        pathPattern: /\/api\/rental\/sessions\/rsess_1\/patches$/,
      },
      {
        label: "approvePatch",
        run: (c) => c.approvePatch("rsess_1", "rpatch_1"),
        method: "POST",
        pathPattern: /\/api\/rental\/sessions\/rsess_1\/patches\/rpatch_1\/approve$/,
      },
      {
        label: "requestPatchChanges",
        run: (c) => c.requestPatchChanges("rsess_1", "rpatch_1", { note: "revise" }),
        method: "POST",
        pathPattern: /\/api\/rental\/sessions\/rsess_1\/patches\/rpatch_1\/request-changes$/,
      },
    ];

    for (const exp of expectations) {
      const { fetchFn, calls } = makeFetchHarness(() => ({ body: {} }));
      const client = makeClient({ fetchFn });
      await exp.run(client);
      assert.equal(calls.length, 1, `${exp.label}: expected 1 fetch call`);
      assert.equal(
        calls[0].init.method,
        exp.method,
        `${exp.label}: method`,
      );
      assert.match(
        calls[0].url,
        exp.pathPattern,
        `${exp.label}: path pattern`,
      );
    }
  });
});
