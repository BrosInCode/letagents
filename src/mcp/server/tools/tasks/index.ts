import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTaskArtifactTools } from "./artifact-tools.js";
import { registerTaskBoardTools } from "./board-tools.js";
import { registerTaskEventTools } from "./event-tools.js";
import { registerTaskLeaseTools } from "./lease-tools.js";
import { registerTaskMutationTools } from "./mutation-tools.js";

export function registerTaskTools(server: McpServer): void {
  registerTaskBoardTools(server);
  registerTaskEventTools(server);
  registerTaskArtifactTools(server);
  registerTaskMutationTools(server);
  registerTaskLeaseTools(server);
}
