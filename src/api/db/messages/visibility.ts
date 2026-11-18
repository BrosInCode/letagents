import { sql } from "drizzle-orm";

import { messages } from "../schema.js";

export function visibleMessageCondition(includePromptOnly = false) {
  return includePromptOnly
    ? sql`TRUE`
    : sql`(${messages.agent_prompt_kind} IS NULL OR ${messages.agent_prompt_kind} <> 'auto' OR BTRIM(${messages.text}) <> '')`;
}

/**
 * Messages every room reader may see: no rental visibility, or the rental's
 * shared stream. A newer kind of reader (My work, the LetAgents API) asks
 * for this; the older room routes do not filter yet.
 */
export function sharedMessageCondition(sharedOnly = false) {
  return sharedOnly
    ? sql`(${messages.visibility} IS NULL OR ${messages.visibility} = 'rental_visible')`
    : sql`TRUE`;
}
