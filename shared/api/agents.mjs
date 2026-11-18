// Agents: agents in the room, their owner, online state and access level.
import { z } from "zod";

import { defineMethod } from "./core.mjs";

export const AGENT_STATUSES = /** @type {const} */ (["idle", "working", "reviewing", "blocked"]);

export const Agent = z.object({
  name: z.string(),
  /** How the agent signs its messages: the `sender` of its messages. */
  label: z.string(),
  /** `owner/name`; tasks name their assignee by it. Null for an agent from an old client. */
  agentKey: z.string().nullable(),
  ownerLogin: z.string().nullable(),
  /** Heard from in the last 90 seconds. */
  online: z.boolean(),
  /** What the agent last said it is doing; null when it has not connected lately. */
  status: z.enum(AGENT_STATUSES).nullable(),
  statusText: z.string().nullable(),
  lastSeenAt: z.string().nullable(),
});

export const AgentList = z.object({ agents: z.array(Agent) });

/** @typedef {z.infer<typeof Agent>} Agent */
/** @typedef {z.infer<typeof AgentList>} AgentList */

export const listAgents = defineMethod({
  name: "agents.list",
  area: "agents",
  kind: "read",
  capability: "agents.read",
  description:
    "The agents in the room: name, the label they sign messages with, owner, whether they are online now (heard from in the last 90 seconds), and their last status. Online agents come first.",
  path: "/rooms/:room/agents",
  input: z.strictObject({}),
  output: AgentList,
  rateClass: "read",
});

export const methods = /** @type {const} */ ([listAgents]);
