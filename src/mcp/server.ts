#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerRoomResources } from "./server/resources.js";
import { registerTools } from "./server/register-tools.js";
import { attachMcpServer, autoJoinFromContext, shutdownRuntime } from "./server/runtime.js";
import { requireValidWorkerBearerRuntime } from "./server/runtime/worker-bearer.js";
import { announceProcessExit } from "./server/runtime/process-connection.js";
import { executionProfile } from "./server/runtime/execution-profile.js";
import { setMcpClientNameSource } from "./server/runtime/identity/config.js";
import { WORKSPACE_CAPTURE_INSTRUCTIONS } from "./server/tools/workspace.js";
import {
  LETAGENTS_RUNTIME_CONTRACT_ARG,
  letAgentsRuntimeContract,
  registerRuntimeReadinessResource,
} from "./server/runtime-contract.js";

const CLIENT_INITIALIZE_WAIT_MS = 5_000;

async function main() {
  if (process.argv.slice(2).includes(LETAGENTS_RUNTIME_CONTRACT_ARG)) {
    process.stdout.write(`${JSON.stringify(letAgentsRuntimeContract())}\n`);
    return;
  }
  const profile = executionProfile();
  const supervisedProvider = process.env.LETAGENTS_SUPERVISOR_PROVIDER?.trim() || null;
  const server = new McpServer({
    name: "letagents",
    version: "0.2.0",
  }, { instructions: profile === "autonomous_mcp_worker" || profile === "interactive_desktop" ? WORKSPACE_CAPTURE_INSTRUCTIONS : undefined });
  attachMcpServer(server);
  registerRoomResources(server);
  registerTools(server, profile, supervisedProvider);
  registerRuntimeReadinessResource(server, profile, supervisedProvider);
  requireValidWorkerBearerRuntime();
  // Auto-join resolves the agent identity, whose IDE label comes from the
  // host's clientInfo, so wait (briefly) for the host to finish initialize.
  setMcpClientNameSource(() => server.server.getClientVersion()?.name);
  const initialized = new Promise<void>((resolve) => {
    server.server.oninitialized = resolve;
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("🔌 Let Agents Chat MCP server running on stdio (v0.6.0)");
  await Promise.race([
    initialized,
    new Promise<void>((resolve) => setTimeout(resolve, CLIENT_INITIALIZE_WAIT_MS).unref()),
  ]);
  await autoJoinFromContext();
}

let exiting = false;
/**
 * Leave once, telling the room on the way out. The host closing stdin is an
 * exit too: without it this process would outlive its host, kept running by
 * the connections it holds, and the room would go on believing it exists.
 */
function exit(): void {
  if (exiting) return;
  exiting = true;
  shutdownRuntime();
  void announceProcessExit().finally(() => process.exit(0));
}

process.on("SIGINT", exit);
process.on("SIGTERM", exit);
process.stdin.on("end", exit);
process.stdin.on("close", exit);

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
