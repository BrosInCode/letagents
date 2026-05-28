import type { DesktopRoomMessage } from "../../../../../../electron/ipc-types";

export interface ThreadSummary {
  count: number;
  latest: DesktopRoomMessage | null;
}

export function buildThreadSummaries(messages: readonly DesktopRoomMessage[]): Map<string, ThreadSummary> {
  const summaries = new Map<string, ThreadSummary>();
  for (const message of messages) {
    const parentId = message.replyTo?.id;
    if (!parentId) continue;
    const summary = summaries.get(parentId) || { count: 0, latest: null };
    summary.count += 1;
    summary.latest = message;
    summaries.set(parentId, summary);
  }
  return summaries;
}
