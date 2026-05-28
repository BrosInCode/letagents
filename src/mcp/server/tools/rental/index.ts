import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { apiCall } from "../../runtime.js";
import { registerRentalActivityTools } from "./activity-tools.js";
import { registerRentalContextTools } from "./context-tools.js";
import { registerRentalMeteringTools } from "./metering-tools.js";
import { registerRentalPatchTools } from "./patch-tools.js";
import { registerRentalProviderTools } from "./provider-tools.js";

export function registerRentalTools(server: McpServer): void {
  const context = {
    server,
    deps: { apiCall },
  };

  registerRentalProviderTools(context);
  registerRentalMeteringTools(context);
  registerRentalContextTools(context);
  registerRentalPatchTools(context);
  registerRentalActivityTools(context);
}
