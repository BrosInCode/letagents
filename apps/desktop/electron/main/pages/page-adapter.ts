import type { DesktopRoomPage } from "../../ipc-types.js";
import { apiFetch, DesktopApiError } from "../auth.js";
import { parsePageGrant, type PageGrant, type PageGrantKeeper } from "./page-grants.js";
import { MAX_ROOM_PAGE_BYTES, PageCallFailure, type PageErrorCode } from "./page-policy.js";

/** The page version a call comes from, as main knows it from the page's lease. */
export interface PageCallContext {
  /** The lease's host: the key of its page grant. */
  leaseId: string;
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

/**
 * Where main reads a room's pinned pages and a page's document, and mints a
 * page's grant. These run with the person's app session; a page's own calls
 * never do.
 */
export interface RoomPageSource {
  list(roomId: string): Promise<DesktopRoomPage[]>;
  load(roomId: string, pageId: string): Promise<{ page: DesktopRoomPage; html: string }>;
  grant(roomId: string, pageId: string): Promise<PageGrant>;
}

export type PageApiHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * One contract method's route under `/api/v1`, copied from its `httpMethod`
 * and `path` in `shared/api`. `:room` is the page's room; other `:name`
 * segments are filled from the input's string fields of that name, and the
 * rest of the input is the query (GET, DELETE) or the JSON body, as the
 * server's router reads it.
 */
export interface PageApiRoute {
  method: PageApiHttpMethod;
  path: string;
}

/**
 * The contract methods a page can call, by name. Each server PR that adds a
 * method a page may use adds it here with the contract's route (a test checks
 * they agree); a name not in this table is `not_found` before anything is
 * sent. Room administration (`rooms.admin`) is never here: a page cannot hold
 * it. Main does not import `shared/api` at run time: it needs zod, which the
 * packaged app's shared folder cannot resolve.
 */
export const PAGE_API_ROUTES: Readonly<Record<string, PageApiRoute>> = {
  "rooms.get": { method: "GET", path: "/rooms/:room" },
  "people.list": { method: "GET", path: "/rooms/:room/people" },
  "people.viewer": { method: "GET", path: "/rooms/:room/people/me" },
  "agents.list": { method: "GET", path: "/rooms/:room/agents" },
  "messages.recent": { method: "GET", path: "/rooms/:room/messages" },
  "messages.thread": { method: "GET", path: "/rooms/:room/messages/:messageId/thread" },
  "tasks.list": { method: "GET", path: "/rooms/:room/tasks" },
  "tasks.get": { method: "GET", path: "/rooms/:room/tasks/:taskId" },
  "planning.get": { method: "GET", path: "/rooms/:room/planning" },
  "work_items.search": { method: "GET", path: "/rooms/:room/work-items" },
  "work_items.get": { method: "GET", path: "/rooms/:room/work-items/:key" },
  "work_items.history": { method: "GET", path: "/rooms/:room/work-items/:key/history" },
  "git.pullRequests": { method: "GET", path: "/rooms/:room/git/pull-requests" },
  "memory.list": { method: "GET", path: "/rooms/:room/memory" },
  "data.list": { method: "GET", path: "/rooms/:room/data/:scope/:collection" },
  "data.get": { method: "GET", path: "/rooms/:room/data/:scope/:collection/:docId" },
  "data.set": { method: "PUT", path: "/rooms/:room/data/:scope/:collection/:docId" },
  "data.update": { method: "PATCH", path: "/rooms/:room/data/:scope/:collection/:docId" },
  "data.delete": { method: "DELETE", path: "/rooms/:room/data/:scope/:collection/:docId" },
  "jobs.start": { method: "POST", path: "/rooms/:room/jobs" },
  "jobs.get": { method: "GET", path: "/rooms/:room/jobs/:id" },
  "jobs.list": { method: "GET", path: "/rooms/:room/jobs" },
  "jobs.cancel": { method: "POST", path: "/rooms/:room/jobs/:id/cancel" },
};

export function pageApiMethodNames(routes: Readonly<Record<string, PageApiRoute>> = PAGE_API_ROUTES): ReadonlySet<string> {
  return new Set(Object.keys(routes));
}

const ERROR_CODES = new Set<PageErrorCode>([
  "invalid_input", "unauthenticated", "not_granted", "not_participant", "not_found", "no_source",
  "source_unavailable", "rate_limited", "conflict", "too_large", "declined", "pending_approval", "internal",
]);

/** For a server answer without the contract's error body (a proxy's page, say). */
const STATUS_CODES: Readonly<Record<number, PageErrorCode>> = {
  400: "invalid_input",
  401: "unauthenticated",
  403: "not_granted",
  404: "not_found",
  409: "conflict",
  413: "too_large",
  429: "rate_limited",
};

/** The request one call makes: its `/api/v1` path, with the page's room, and its body. */
export function pageApiRequest(
  route: PageApiRoute,
  roomId: string,
  input: unknown,
): { path: string; init: RequestInit } {
  const fields: Record<string, unknown> = input && typeof input === "object" && !Array.isArray(input)
    ? { ...(input as Record<string, unknown>) }
    : {};
  // The room is always the page's own; a page cannot name another room.
  delete fields.room;
  const routePath = route.path.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, (_match, name: string) => {
    if (name === "room") return encodeURIComponent(roomId);
    const value = fields[name];
    // A dot segment or a slash would move the call to another route, even encoded behind a proxy.
    if (typeof value !== "string" || !value || value === "." || value === ".." || /[/\\]/.test(value)) {
      throw new PageCallFailure("invalid_input", `The call needs "${name}" as one name, without slashes.`);
    }
    delete fields[name];
    return encodeURIComponent(value);
  });
  const base = `/api/v1${routePath}`;
  if (route.method === "GET" || route.method === "DELETE") {
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(fields)) {
      if (value === undefined || value === null) continue;
      // A list repeats its key (`fields=a&fields=b`), as the server's query parser reads it.
      for (const item of Array.isArray(value) ? value : [value]) {
        query.append(name, typeof item === "string" || typeof item === "number" || typeof item === "boolean" ? String(item) : JSON.stringify(item));
      }
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
      : STATUS_CODES[error.status] ?? "source_unavailable";
    const retryAfterMs = typeof payload?.retryAfterMs === "number" && Number.isFinite(payload.retryAfterMs)
      ? payload.retryAfterMs
      : undefined;
    return new PageCallFailure(code, typeof payload?.message === "string" ? payload.message : error.message, retryAfterMs);
  }
  return new PageCallFailure("source_unavailable", "LetAgents could not be reached. Try again in a moment.");
}

/**
 * The adapter the app uses: each method's route in `routes`, sent with the
 * lease's own `page_grant` token and never with the person's session. A
 * lease without a token gets `not_granted`.
 */
export function createHttpPageApiAdapter(options: {
  grants: Pick<PageGrantKeeper, "token">;
  routes?: Readonly<Record<string, PageApiRoute>>;
  fetchApi?: typeof apiFetch;
}): PageApiAdapter {
  const routes = options.routes ?? PAGE_API_ROUTES;
  const fetchApi = options.fetchApi ?? apiFetch;
  return {
    async call(lease, method, input) {
      const route = Object.hasOwn(routes, method) ? routes[method] : undefined;
      if (!route) throw new PageCallFailure("not_found", `There is no method "${method}".`);
      const request = pageApiRequest(route, lease.roomId, input);
      const token = await options.grants.token(lease.leaseId);
      if (!token) throw new PageCallFailure("not_granted", "This page has no grant in this room.");
      const headers = new Headers(request.init.headers);
      headers.set("Authorization", `Bearer ${token}`);
      try {
        return await fetchApi<unknown>(request.path, { ...request.init, headers }, { credential: "none" });
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
    async grant(roomId, pageId) {
      const body = await fetchApi<unknown>(
        `${roomBase(roomId)}/${encodeURIComponent(pageId)}/grant`,
        { method: "POST", body: "{}" },
        { credential: "app" },
      );
      const grant = parsePageGrant(body);
      if (!grant) throw new Error("The server sent no page grant.");
      return grant;
    },
  };
}

type MemoryCall = { lease: PageCallContext; method: string; input: unknown; token: string };

/**
 * Pages, grants and answers held in memory, for tests. `handlers` answer calls
 * by method name; like the server, a call needs the lease's grant token.
 * `grantFails` makes every mint fail.
 */
export function createMemoryPageBackend(input: {
  pages?: Record<string, Array<DesktopRoomPage & { html: string }>>;
  handlers?: Record<string, (lease: PageCallContext, input: unknown) => unknown>;
  grants: Pick<PageGrantKeeper, "token">;
  grantFails?: () => boolean;
  grantTtlMs?: number;
}): { adapter: PageApiAdapter; source: RoomPageSource; calls: MemoryCall[]; mints: Array<{ roomId: string; pageId: string }> } {
  const calls: MemoryCall[] = [];
  const mints: Array<{ roomId: string; pageId: string }> = [];
  return {
    calls,
    mints,
    adapter: {
      async call(lease, method, callInput) {
        const token = await input.grants.token(lease.leaseId);
        if (!token) throw new PageCallFailure("not_granted", "This page has no grant in this room.");
        calls.push({ lease, method, input: callInput, token });
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
      async grant(roomId, pageId) {
        mints.push({ roomId, pageId });
        if (input.grantFails?.()) throw new Error("The grant was refused.");
        return { token: `grant-${mints.length}`, expiresAt: Date.now() + (input.grantTtlMs ?? 15 * 60_000), capabilities: ["rooms.read"] };
      },
    },
  };
}
