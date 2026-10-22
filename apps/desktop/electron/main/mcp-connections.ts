import { apiFetch } from "./auth.js";

/** An app signed in to this account's remote MCP endpoint with OAuth. */
export interface RemoteMcpConnectionView {
  id: string;
  client_name: string | null;
  redirect_hosts: string[];
  scope: string;
  created_at: string;
  last_used_at: string;
  expires_at: string;
}

const CONNECTION_ID = /^mcpgrant_[0-9a-f-]{36}$/;

export function listRemoteMcpConnections(): Promise<{ connections: RemoteMcpConnectionView[] }> {
  return apiFetch<{ connections: RemoteMcpConnectionView[] }>("/account/mcp-connections");
}

/** Revokes the app's tokens and ends its remote MCP sessions. */
export async function disconnectRemoteMcpConnection(id: unknown): Promise<void> {
  if (typeof id !== "string" || !CONNECTION_ID.test(id)) throw new Error("Choose a connected app.");
  await apiFetch(`/account/mcp-connections/${id}`, { method: "DELETE" });
}
