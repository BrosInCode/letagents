/** Parsing of Codex permission requests and the owner elicitations the adapter declines. */
import { LETAGENTS_MCP_SERVER_NAME } from "../../../../../../shared/codex-owner-isolation.mjs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { CodexPermissionFileChange } from "../../../../shared/provider-permissions.js";
import type { RpcServerRequest } from "../codex-rpc-client.js";
import { nativeExecutionId } from "../provider-execution-observer.js";
import { recordValue } from "./notifications.js";

export const permissionString = z.string().max(4096);
export const permissionSpecialPath = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("root") }),
  z.strictObject({ kind: z.literal("minimal") }),
  z.strictObject({ kind: z.literal("project_roots"), subpath: permissionString.nullable().optional() }),
  z.strictObject({ kind: z.literal("tmpdir") }),
  z.strictObject({ kind: z.literal("slash_tmp") }),
  z.strictObject({ kind: z.literal("unknown"), path: permissionString, subpath: permissionString.nullable().optional() }),
]);
export const permissionPath = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("path"), path: permissionString }),
  z.strictObject({ type: z.literal("glob_pattern"), pattern: permissionString }),
  z.strictObject({ type: z.literal("special"), value: permissionSpecialPath }),
]);
export const permissionFileSystem = z.strictObject({
  entries: z.array(z.strictObject({ access: z.enum(["read", "write", "deny"]), path: permissionPath })).max(128).nullable().optional(),
  globScanMaxDepth: z.number().int().positive().max(4096).nullable().optional(),
  read: z.array(permissionString).max(128).nullable().optional(),
  write: z.array(permissionString).max(128).nullable().optional(),
});
export const permissionProfileSchema = z.strictObject({
  fileSystem: permissionFileSystem.nullable().optional(),
  network: z.strictObject({ enabled: z.boolean().nullable().optional() }).nullable().optional(),
});

export function permissionProfile(value: unknown): Record<string, unknown> | null {
  if (!permissionProfileSchema.safeParse(value).success) return null;
  try {
    return Buffer.byteLength(JSON.stringify(value)) <= 24 * 1024 ? value as Record<string, unknown> : null;
  } catch { return null; }
}

export function permissionParams(request: RpcServerRequest): Record<string, unknown> | null {
  if (request.method === "mcpServer/elicitation/request") {
    const params = recordValue(request.params);
    const metadata = recordValue(params?._meta);
    // Codex uses an empty form for a single MCP tool approval. Data-entry and
    // URL elicitations require a different interaction and cannot be accepted here.
    const schema = z.strictObject({ type: z.literal("object"), properties: z.record(z.string(), z.never()),
      required: z.array(z.never()).optional() });
    if (!params || !nativeExecutionId(params.threadId) || !nativeExecutionId(params.turnId)
      || params.mode !== "form" || !nativeExecutionId(params.serverName)
      || typeof params.message !== "string" || !params.message.trim() || params.message.length > 8192
      || metadata?.codex_approval_kind !== "mcp_tool_call" || !recordValue(metadata.tool_params)
      || !schema.safeParse(params.requestedSchema).success) return null;
    try { return Buffer.byteLength(JSON.stringify(params)) <= 24 * 1024 ? params : null; }
    catch { return null; }
  }
  if (!["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval"]
    .includes(request.method)) return null;
  const params = recordValue(request.params);
  if (!params || !nativeExecutionId(params.threadId) || !nativeExecutionId(params.turnId)
    || !nativeExecutionId(params.itemId) || !Number.isSafeInteger(params.startedAtMs)
    || (params.startedAtMs as number) < 0) return null;
  if (request.method !== "item/permissions/requestApproval") return params;
  return typeof params.cwd === "string" && params.cwd.length <= 4096 && isAbsolute(params.cwd)
    && permissionProfile(params.permissions)
    && (params.reason == null || (typeof params.reason === "string" && params.reason.length <= 8192))
    && (params.environmentId == null || (typeof params.environmentId === "string" && params.environmentId.length <= 512))
    ? params : null;
}

/**
 * With the owner's own setup on, their MCP servers can ask a person for typed
 * input or a browser sign-in, or send a tool approval too large to show.
 * LetAgents can show only a tool approval of bounded size, so nobody could
 * answer and the turn would wait forever. Without the owner's setup the only
 * MCP server Codex runs is the room's, and the room's own requests are never
 * answered here, so nothing changes for such an agent.
 */
export function isUnanswerableOwnerElicitation(request: RpcServerRequest): boolean {
  return request.method === "mcpServer/elicitation/request" && permissionParams(request) === null
    && recordValue(request.params)?.serverName !== LETAGENTS_MCP_SERVER_NAME;
}

/** What the owner is told in the agent's activity about a request that was turned down for them. */
export function declinedOwnerRequestSummary(request: RpcServerRequest): string {
  const params = recordValue(request.params);
  const name = typeof params?.serverName === "string" ? params.serverName.trim().replace(/[^\x20-\x7e]/g, "?").slice(0, 64) : "";
  const server = name ? `your MCP server ${JSON.stringify(name)}` : "one of your MCP servers";
  if (recordValue(params?._meta)?.codex_approval_kind === "mcp_tool_call") {
    return `Did not allow a tool of ${server}. Its approval request was too large or malformed to show.`;
  }
  return `Declined a request for ${params?.mode === "url" ? "a sign-in" : "typed input"} from ${server}. LetAgents cannot show it.`;
}

export function permissionFileChanges(value: unknown): CodexPermissionFileChange[] | null {
  if (!Array.isArray(value) || !value.length || value.length > 128) return null;
  const path = (input: unknown): input is string => typeof input === "string" && input.trim().length > 0
    && input.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(input);
  const changes: CodexPermissionFileChange[] = [];
  for (const entry of value) {
    const item = recordValue(entry); const kind = recordValue(item?.kind);
    if (!item || Object.keys(item).length !== 3 || !path(item.path) || typeof item.diff !== "string"
      || item.diff.length > 24 * 1024 || !kind) return null;
    if (kind.type === "add" || kind.type === "delete") {
      if (Object.keys(kind).length !== 1) return null;
      changes.push({ path: item.path, kind: { type: kind.type }, diff: item.diff });
    } else if (kind.type === "update" && Object.keys(kind).length === 2
      && (kind.move_path === null || path(kind.move_path))) {
      changes.push({ path: item.path, kind: { type: "update", move_path: kind.move_path }, diff: item.diff });
    } else return null;
  }
  return Buffer.byteLength(JSON.stringify(changes)) <= 24 * 1024 ? changes : null;
}
