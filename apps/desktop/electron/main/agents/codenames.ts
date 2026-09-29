import { randomUUID } from "node:crypto";

import {
  agentCodenameAt,
  agentCodenameSeedIndex,
  suggestFreeAgentCodename,
} from "../../../../../shared/agent-codenames.mjs";

/** Shown to agents as the shape of a LetAgents name; not a separate pool. */
export const LETAGENTS_CODENAME_EXAMPLES = [
  "MapleRidge",
  "CedarVista",
  "DawnWinter",
  "GardenFern",
  "SilverHarbor",
] as const;

/**
 * A generated name that none of `existingNames` already answers to, drawn
 * from the pool every LetAgents runtime shares. Names are compared the way
 * mentions are, so a different spelling of a held name is still held.
 */
export function suggestLetAgentsCodename(
  existingNames: Iterable<string | null | undefined> = [],
  seed: string = randomUUID(),
): string {
  return suggestFreeAgentCodename(existingNames, seed)
    ?? agentCodenameAt(agentCodenameSeedIndex(seed));
}
