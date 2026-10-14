/**
 * Short summary for the Conversation row in the room settings navigation.
 * The nav row has little room, so it names a single active setting and
 * counts them when more than one is on (same "N on" style as Alerts).
 *
 * `routing` is the RoomConversationRouting summary ("Smart" or "Standard");
 * only "Smart" is an active setting. `replyOrder` is "In turns" when on.
 */
export function conversationSettingsSummary(routing: string | null, replyOrder: string | null): string | null {
  const active = [routing === "Smart" ? routing : null, replyOrder].filter((value): value is string => Boolean(value));
  if (active.length > 1) return `${active.length} on`;
  return active[0] ?? null;
}
