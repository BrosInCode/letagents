#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerRoomResources } from "./server/resources.js";
import { registerTools } from "./server/register-tools.js";
import { attachMcpServer, autoJoinFromContext, shutdownRuntime } from "./server/runtime.js";
import { requireValidWorkerBearerRuntime } from "./server/runtime/worker-bearer.js";

const server = new McpServer({
  name: "letagents",
  version: "0.2.0",
});

attachMcpServer(server);
registerRoomResources(server);
registerTools(server);

async function main() {
  requireValidWorkerBearerRuntime();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("🔌 Let Agents Chat MCP server running on stdio (v0.6.0)");
  await autoJoinFromContext();
}

process.on("SIGINT", () => {
  shutdownRuntime();
  process.exit(0);
});

process.on("SIGTERM", () => {
  shutdownRuntime();
  process.exit(0);
});

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
