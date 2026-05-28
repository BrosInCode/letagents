import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { RentalToolDeps } from "../../../rental-tools.js";

export interface RentalToolRegistrationContext {
  server: McpServer;
  deps: RentalToolDeps;
}
