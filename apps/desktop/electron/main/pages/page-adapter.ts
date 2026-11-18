import type { DesktopRoomPage } from "../../ipc-types.js";
import { apiFetch, DesktopApiError } from "../auth.js";
import { MAX_ROOM_PAGE_BYTES, PageCallFailure, type PageErrorCode } from "./page-policy.js";

/** The page version a call comes from, as main knows it from the page's lease. */
export interface PageCallContext {
  roomId: string;
  pageId: string;
  version: number;
}

/**
 * Where main sends a page's API calls once the bridge has checked the sender,
 * the method name and the rate. The server decides what the page may do; an
 * adapter holds no permission logic. A refusal is a `PageCallFailure`.
 */
export interface PageApiAdapter {
  call(lease: PageCallContext, method: string, input: unknown): Promise<unknown>;
}

/** Where main reads a room's pinned pages and a page's document. */
export interface RoomPageSource {
  list(roomId: string): Promise<DesktopRoomPage[]>;
  load(roomId: string, pageId: string): Promise<{ page: DesktopRoomPage; html: string }>;
}

export type PageApiHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * One contract method on its `/api/v1/rooms/<room>` route. `:name` segments
 * are filled from the input's string fields of that name; the rest of the
 * input is the query (GET, DELETE) or the JSON body.
 */
export interface PageApiRoute {
  method: PageApiHttpMethod;
  path: string;
}

/**
 * The contract methods a page can call, by name. Each server PR that adds a
 * `/api/v1` route adds its methods here; a name not in this table is
 * `not_found` before anything is sent.
 */
export const PAGE_API_ROUTES: Readonly<Record<string, PageApiRoute>> = {
  "rooms.get": { method: "GET", path: "" },
};

export function pageApiMethodNames(routes: Readonly<Record<string, PageApiRoute>> = PAGE_API_ROUTES): ReadonlySet<string> {
  return new Set(Object.keys(routes));
}

const ERROR_CODES = new Set<PageErrorCode>([
  "not_granted", "not_participant", "not_found", "no_source", "source_unavailable",
  "rate_limited", "conflict", "too_large", "declined", "pending_approval",
]);

/** The request one call makes: its path under `/api/v1/rooms/<room>` and its body. */
export function pageApiRequest(
  route: PageApiRoute,
  roomId: string,
  input: unknown,
): { path: string; init: RequestInit } {
  const fields: Record<string, unknown> = input && typeof input === "object" && !Array.isArray(input)
    ? { ...(input as Record<string, unknown>) }
    : {};
  const routePath = route.path.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, (_match, name: string) => {
    const value = fields[name];
    if (typeof value !== "string" || !value) throw new PageCallFailure("not_found", `The call needs "${name}".`);
    delete fields[name];
    return encodeURIComponent(value);
  });
  const base = `/api/v1/rooms/${encodeURIComponent(roomId)}${routePath}`;
  if (route.method === "GET" || route.method === "DELETE") {
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(fields)) {
      if (value === undefined || value === null) continue;
      query.set(name, typeof value === "string" ? value : JSON.stringify(value));
    }
    const search = query.toString();
    return { path: search ? `${base}?${search}` : base, init: { method: route.method } };
  }
  return { path: base, init: { method: route.method, body: JSON.stringify(fields) } };
}

/** A server refusal in the page's error shape; anything else is `source_unavailable`. */
export function pageCallFailureFromApi(error: unknown): PageCallFailure {
  if (error instanceof PageCallFailure) return error;
  if (error instanceof DesktopApiError) {
    const payload = error.payload as { code?: unknown; message?: unknown; retryAfterMs?: unknown } | null;
    const code = typeof payload?.code === "string" && ERROR_CODES.has(payload.code as PageErrorCode)
      ? payload.code as PageErrorCode
      : error.status === 404 ? "not_found"
        : error.status === 403 ? "not_granted"
          : error.status === 409 ? "conflict"
            : error.status === 413 ? "too_large"
              : error.status === 429 ? "rate_limited"
                : "source_unavailable";
    const retryAfterMs = typeof payload?.retryAfterMs === "number" && Number.isFinite(payload.retryAfterMs)
      ? payload.retryAfterMs
      : undefined;
    return new PageCallFailure(code, typeof payload?.message === "string" ? payload.message : error.message, retryAfterMs);
  }
  return new PageCallFailure("source_unavailable", "LetAgents could not be reached. Try again in a moment.");
}

/**
 * The adapter the app uses: each method's route in `routes`, with the app's
 * own sign-in. The page id and version go with every call so the server can
 * record "via <page>".
 */
export function createHttpPageApiAdapter(
  routes: Readonly<Record<string, PageApiRoute>> = PAGE_API_ROUTES,
  fetchApi: typeof apiFetch = apiFetch,
): PageApiAdapter {
  return {
    async call(lease, method, input) {
      const route = Object.hasOwn(routes, method) ? routes[method] : undefined;
      if (!route) throw new PageCallFailure("not_found", `There is no method "${method}".`);
      const request = pageApiRequest(route, lease.roomId, input);
      const headers = new Headers(request.init.headers);
      headers.set("X-LetAgents-Page", `${lease.pageId}@${lease.version}`);
      try {
        return await fetchApi<unknown>(request.path, { ...request.init, headers }, { credential: "app" });
      } catch (error) {
        throw pageCallFailureFromApi(error);
      }
    },
  };
}

function roomPage(value: unknown): DesktopRoomPage | null {
  if (!value || typeof value !== "object") return null;
  const { id, title, version } = value as Record<string, unknown>;
  if (typeof id !== "string" || !id || typeof version !== "number" || !Number.isInteger(version) || version < 1) return null;
  return { id, title: typeof title === "string" && title.trim() ? title.trim().slice(0, 80) : "Page", version };
}

/**
 * The room's pinned pages and their documents from the server. A server
 * without page routes yet answers 404, which is a room with no pages.
 */
export function createHttpRoomPageSource(fetchApi: typeof apiFetch = apiFetch): RoomPageSource {
  const roomBase = (roomId: string) => `/api/v1/rooms/${encodeURIComponent(roomId)}/pages`;
  return {
    async list(roomId) {
      let body: { pages?: unknown };
      try {
        body = await fetchApi<{ pages?: unknown }>(`${roomBase(roomId)}?surface=room.tab`, undefined, { credential: "app" });
      } catch (error) {
        if (error instanceof DesktopApiError && error.status === 404) return [];
        throw error;
      }
      return Array.isArray(body?.pages) ? body.pages.map(roomPage).filter((page): page is DesktopRoomPage => page !== null) : [];
    },
    async load(roomId, pageId) {
      const body = await fetchApi<{ page?: unknown; html?: unknown }>(
        `${roomBase(roomId)}/${encodeURIComponent(pageId)}/document`,
        undefined,
        { credential: "app" },
      );
      const page = roomPage(body?.page);
      if (!page || page.id !== pageId || typeof body.html !== "string") throw new Error("The page could not be loaded.");
      if (Buffer.byteLength(body.html, "utf8") > MAX_ROOM_PAGE_BYTES) throw new Error("This page is larger than 2 MB, so it does not open.");
      return { page, html: body.html };
    },
  };
}

/**
 * Pages and answers held in memory: tests, and a desktop without the server
 * routes. `handlers` answer calls by method name.
 */
export function createMemoryPageBackend(input: {
  pages?: Record<string, Array<DesktopRoomPage & { html: string }>>;
  handlers?: Record<string, (lease: PageCallContext, input: unknown) => unknown>;
} = {}): { adapter: PageApiAdapter; source: RoomPageSource; calls: Array<{ lease: PageCallContext; method: string; input: unknown }> } {
  const calls: Array<{ lease: PageCallContext; method: string; input: unknown }> = [];
  return {
    calls,
    adapter: {
      async call(lease, method, callInput) {
        calls.push({ lease, method, input: callInput });
        const handler = input.handlers?.[method];
        if (!handler) throw new PageCallFailure("not_found", `There is no method "${method}".`);
        return handler(lease, callInput);
      },
    },
    source: {
      async list(roomId) {
        return (input.pages?.[roomId] ?? []).map(({ id, title, version }) => ({ id, title, version }));
      },
      async load(roomId, pageId) {
        const found = input.pages?.[roomId]?.find((page) => page.id === pageId);
        if (!found) throw new Error("The page could not be loaded.");
        const { html, ...page } = found;
        return { page, html };
      },
    },
  };
}
