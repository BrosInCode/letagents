import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { agentToolDescription, agentToolMethods, agentToolName } from "../../../../shared/api/agent-tools.mjs";
import { ApiErrorBody, type AnyApiMethod } from "../../../../shared/api/core.mjs";
import { isLocalRoomStorageEnabled, roomScopedApiCall } from "../runtime.js";
import { ApiError } from "../runtime/api.js";
import { roomAccessToolResponse } from "../runtime/room-access.js";
import { resolveTaskToolTarget } from "./tasks/context.js";
import { jsonToolResponse } from "./tasks/response.js";

// MCP tools made from the LetAgents API contract (shared/api). Each method
// flagged `agents` becomes one tool that calls /api/v1 in the agent's room
// with the agent's own credential, so the server checks an agent exactly as
// it checks a page or an app. A new flagged method needs no code here.

/** A tracker search may take a while; a call that hangs longer helps nobody. */
export const API_TOOL_TIMEOUT_MS = 60_000;

const roomId = z.string().optional().describe("Exact room ID. Defaults to this worker’s room.");

/** For an answer without the API's error body. */
const STATUS_CODES: Readonly<Record<number, string>> = {
  400: "invalid_input",
  401: "unauthenticated",
  403: "not_granted",
  404: "not_found",
  409: "conflict",
  413: "too_large",
  429: "rate_limited",
};

const LOCAL_ROOM_MESSAGE ="The LetAgents API needs a room shared online; this room is stored on this device.";

/** One tool's input: the method's own fields, and the room like every room tool. */
export function apiToolInputShape(method: AnyApiMethod): z.ZodRawShape {
  if (!(method.input instanceof z.ZodObject)) {
    throw new Error(`API method ${method.name}: an agent tool needs an object input.`);
  }
  const shape = method.input.shape as z.ZodRawShape;
  if (Object.hasOwn(shape, "room_id") || Object.hasOwn(shape, "room")) {
    throw new Error(`API method ${method.name}: "room" and "room_id" are the tool's own fields.`);
  }
  return { ...shape, room_id: roomId };
}

/**
 * The part of the request after `/api/v1/rooms/<room>`, the way the server's
 * router reads it: `:name` path segments from the input, the rest as the
 * query (GET, DELETE) or the JSON body.
 */
export function apiMethodRequest(method: AnyApiMethod, input: Record<string, unknown>): { path: string; init: RequestInit } {
  const fields: Record<string, unknown> = { ...input };
  const route = method.path.slice("/rooms/:room".length).replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name: string) => {
    const value = fields[name];
    // A dot segment or a slash would move the call to another route.
    if (typeof value !== "string" || !value || value === "." || value === ".." || /[/\\]/.test(value)) {
      throw new Error(`${name} must be one name, without slashes.`);
    }
    delete fields[name];
    return encodeURIComponent(value);
  });
  if (method.httpMethod === "GET" || method.httpMethod === "DELETE") {
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(fields)) {
      for (const item of Array.isArray(value) ? value : [value]) {
        if (item === undefined || item === null) continue;
        query.append(name, typeof item === "string" ? item : typeof item === "object" ? JSON.stringify(item) : String(item));
      }
    }
    const search = query.toString();
    return { path: search ? `${route}?${search}` : route, init: { method: method.httpMethod } };
  }
  return { path: route, init: { method: method.httpMethod, body: JSON.stringify(fields) } };
}

/** Calls one contract method in the agent's room (or `roomIdInput`) and returns its output. */
export async function callApiMethod<T = unknown>(
  method: AnyApiMethod,
  input: Record<string, unknown>,
  roomIdInput?: string,
): Promise<T> {
  const target = resolveTaskToolTarget(roomIdInput);
  if (!target) throw new Error("Join a room first.");
  if (await isLocalRoomStorageEnabled(target.effectiveRoomId || target.roomId || target.projectId!)) {
    throw new Error(LOCAL_ROOM_MESSAGE);
  }
  const { path, init } = apiMethodRequest(method, input);
  const at = (room: string) => `/api/v1/rooms/${encodeURIComponent(room)}${path}`;
  return roomScopedApiCall<T>({
    room_id: target.roomId,
    project_id: target.projectId,
    room_path: at,
    project_path: at,
    options: { ...init, signal: AbortSignal.timeout(API_TOOL_TIMEOUT_MS) },
    // Reading messages through the API is not reading the room's delivery queue.
    preserve_session_cursor: true,
  });
}

/** A refusal as `{ success: false, error: <API error code>, message }`; sign-in and membership refusals keep their own result. */
export function apiToolError(error: unknown) {
  const access = roomAccessToolResponse(error);
  if (access) return access;
  if (error instanceof ApiError) {
    let body: unknown = null;
    try {
      body = JSON.parse(error.body);
    } catch {
      // Not the API's error shape: a proxy's page, an older server.
    }
    const parsed = ApiErrorBody.safeParse(body);
    if (parsed.success) {
      const { code, message, retryAfterMs } = parsed.data;
      return jsonToolResponse({ success: false, error: code, message, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
    }
    // Refused before the API's own pipeline (the credential's route check) or by a server without /api/v1.
    const said = body && typeof body === "object" ? (body as Record<string, unknown>).error ?? (body as Record<string, unknown>).message : null;
    return jsonToolResponse({
      success: false,
      error: STATUS_CODES[error.status] ?? "source_unavailable",
      message: typeof said === "string" && said
        ? said
        : error.status === 404 ? "This LetAgents server does not have this API method." : `LetAgents answered ${error.status}.`,
    });
  }
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return jsonToolResponse({
      success: false,
      error: "source_unavailable",
      message: `LetAgents did not answer within ${API_TOOL_TIMEOUT_MS / 1000} s. Try again shortly.`,
    });
  }
  return jsonToolResponse({ success: false, error: error instanceof Error ? error.message : String(error) });
}

export function registerApiTools(server: McpServer, methods: readonly AnyApiMethod[] = agentToolMethods()): void {
  for (const method of methods) {
    server.tool(
      agentToolName(method),
      agentToolDescription(method),
      apiToolInputShape(method),
      async ({ room_id, ...input }: Record<string, unknown>) => {
        try {
          return jsonToolResponse(await callApiMethod(method, input, room_id as string | undefined));
        } catch (error) {
          return apiToolError(error);
        }
      },
    );
  }
}
