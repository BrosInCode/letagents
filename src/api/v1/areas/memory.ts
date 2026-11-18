import { listMemory, type MemoryAuthor } from "../../../../shared/api/memory.mjs";
import type { KnowledgeActor } from "../../../../shared/room-knowledge.mjs";
import { listRoomKnowledge } from "../../db/room-knowledge.js";
import { defineRoute, type ApiRoute } from "../route.js";

// Routes for the methods in shared/api/memory.mjs, made with defineRoute.
export const routes: readonly ApiRoute[] = [
  defineRoute(listMemory, async (_input, { room }) => {
    const page = await listRoomKnowledge(room.id, "memory");
    return {
      truncated: page.truncated,
      facts: page.records.map((record) => ({
        id: record.id,
        category: record.category,
        title: record.title,
        body: record.body,
        sourceUrl: record.source_url || null,
        sourceMessageId: record.source_message_id || null,
        author: toAuthor(record.author),
        updatedBy: toAuthor(record.updated_by),
        createdAt: record.created_at,
        updatedAt: record.updated_at,
        archived: record.archived,
      })),
    };
  }),
];

function toAuthor(actor: KnowledgeActor): MemoryAuthor {
  return { name: actor.label, kind: actor.kind === "agent" ? "agent" : "person" };
}
