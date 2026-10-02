import { and, desc, eq, or } from "drizzle-orm";
import { db } from "../client.js";
import { github_room_events as events } from "../schema.js";
import {
  linkPreviewState, parseGitHubLinkReference,
  type LinkPreviewReference, type MessageLinkPreview,
} from "../../../../shared/message-link-previews.mjs";

/** The caller supplies the already-authorized Events lane, never a client repository. */
export async function getMessageLinkPreviews(roomId: string, references: LinkPreviewReference[]): Promise<MessageLinkPreview[]> {
  if (!references.length) return [];
  const rows = await db.selectDistinctOn([events.event_type, events.github_object_id], {
    type: events.event_type, number: events.github_object_id, url: events.github_object_url,
    title: events.title, state: events.state, metadata: events.metadata,
  }).from(events).where(and(eq(events.room_id, roomId), or(...references.map((ref) => and(
    eq(events.event_type, ref.kind === "pull" ? "pull_request" : "issue"),
    eq(events.github_object_id, String(ref.number)),
  ))))).orderBy(events.event_type, events.github_object_id, desc(events.event_order_at), desc(events.id));
  return rows.flatMap((row) => {
    const ref = parseGitHubLinkReference(row.url);
    const state = linkPreviewState(row.state, row.metadata);
    if (!ref || !state || !row.title?.trim() || String(ref.number) !== row.number
      || (ref.kind === "pull" ? row.type !== "pull_request" : row.type !== "issue" || row.metadata?.is_pull_request === true)) return [];
    return [{ ...ref, title: row.title, state }];
  });
}
