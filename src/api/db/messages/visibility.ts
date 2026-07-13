import { sql } from "drizzle-orm";

import { messages } from "../schema.js";

export function visibleMessageCondition(includePromptOnly = false) {
  return includePromptOnly
    ? sql`TRUE`
    : sql`(${messages.agent_prompt_kind} IS NULL OR ${messages.agent_prompt_kind} <> 'auto' OR BTRIM(${messages.text}) <> '')`;
}
