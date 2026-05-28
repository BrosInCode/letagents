import { sql } from "drizzle-orm";

import { messages } from "../schema.js";

export function visibleMessageCondition(includePromptOnly = false) {
  return includePromptOnly
    ? sql`TRUE`
    : sql`NOT (${messages.agent_prompt_kind} = 'auto' AND BTRIM(${messages.text}) = '')`;
}
