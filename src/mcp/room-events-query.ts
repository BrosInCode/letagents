export interface RoomEventsQueryInput {
  event_type?: string;
  object_id?: string;
  actor?: string;
  since?: string;
  until?: string;
  after?: string;
  limit?: number;
}

export function buildRoomEventsQueryString(input: RoomEventsQueryInput): string {
  const params = new URLSearchParams();

  if (input.event_type) params.set("event_type", input.event_type);
  if (input.object_id) params.set("object_id", input.object_id);
  if (input.actor) params.set("actor", input.actor);
  if (input.since) params.set("since", input.since);
  if (input.until) params.set("until", input.until);
  if (input.after) params.set("after", input.after);
  if (input.limit) params.set("limit", String(input.limit));

  return params.toString();
}
