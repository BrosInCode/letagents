// Memory: the facts the room remembers.
import { z } from "zod";

import { defineMethod } from "./core.mjs";

export const MemoryAuthor = z.object({
  name: z.string(),
  kind: z.enum(["person", "agent"]),
});

export const MemoryFact = z.object({
  id: z.string(),
  /** `goal`, `decision`, `constraint`, `term` or `reference`. */
  category: z.string(),
  title: z.string(),
  body: z.string(),
  sourceUrl: z.string().nullable(),
  /** The room message the fact came from. */
  sourceMessageId: z.string().nullable(),
  author: MemoryAuthor,
  updatedBy: MemoryAuthor,
  createdAt: z.string(),
  updatedAt: z.string(),
  /** A person retired the fact; it no longer holds. */
  archived: z.boolean(),
});

export const MemoryList = z.object({
  /** Current facts first, then archived ones; newest change first within each. */
  facts: z.array(MemoryFact),
  /** True when the room has more facts than the list holds (200). */
  truncated: z.boolean(),
});

/** @typedef {z.infer<typeof MemoryAuthor>} MemoryAuthor */
/** @typedef {z.infer<typeof MemoryFact>} MemoryFact */
/** @typedef {z.infer<typeof MemoryList>} MemoryList */

export const listMemory = defineMethod({
  name: "memory.list",
  area: "memory",
  kind: "read",
  capability: "memory.read",
  description:
    "The facts the room remembers (goals, decisions, constraints, terms and references), current facts first. Archived facts are included and marked.",
  path: "/rooms/:room/memory",
  input: z.strictObject({}),
  output: MemoryList,
  rateClass: "read",
});

export const methods = /** @type {const} */ ([listMemory]);
