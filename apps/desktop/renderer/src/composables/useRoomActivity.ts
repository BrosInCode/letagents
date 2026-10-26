import { onScopeDispose, shallowRef, watch, type Ref } from "vue";
import type { DesktopAgentPresence } from "../../../electron/ipc-types";
import type { ComposerEventPreview } from "../components/desktop/content/room-chat/composer-event-preview";
import {
  createActivityNoticeQueue,
  presenceTimelineText,
  type ActivityNotice,
  type PresenceTimelineLine,
} from "../components/desktop/content/room-chat/room-activity";
import { useAgentPresenceChips } from "./useAgentPresenceChips";

/** Join and leave lines kept in one room's timeline. */
export const PRESENCE_TIMELINE_LIMIT = 50;

/**
 * The notices on a room's activity line: agents joining and leaving, and
 * GitHub updates. Joins and leaves also leave a quiet line in the timeline,
 * which this window keeps until the room changes. A GitHub update stays off
 * the line while someone is writing, as it did in the composer.
 */
export function useRoomActivity(input: {
  presence: () => readonly DesktopAgentPresence[];
  scope: () => string | null;
  ready: () => boolean;
  eventPreviews: () => readonly ComposerEventPreview[];
  drafting: () => boolean;
}): {
  notice: Ref<ActivityNotice | null>;
  presenceLines: Ref<readonly PresenceTimelineLine[]>;
  pause(): void;
  resume(): void;
  confirmSteer(displayName: string): void;
} {
  const notice = shallowRef<ActivityNotice | null>(null);
  const presenceLines = shallowRef<readonly PresenceTimelineLine[]>([]);
  let sequence = 0;
  const queue = createActivityNoticeQueue({
    now: () => Date.now(),
    set: (callback, ms) => setTimeout(callback, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  }, () => { notice.value = queue.current(); });

  useAgentPresenceChips({
    presence: input.presence,
    scope: input.scope,
    ready: input.ready,
    onChanges(changes) {
      const timestamp = new Date().toISOString();
      presenceLines.value = [...presenceLines.value, ...changes.map((change) => ({
        id: `presence:${change.id}`, timestamp, kind: change.kind, text: presenceTimelineText(change.kind, change),
      }))].slice(-PRESENCE_TIMELINE_LIMIT);
      for (const change of changes) {
        queue.push(change.kind === "connected"
          ? { kind: "join", id: `join:${change.id}`, agents: [change] }
          : { kind: "leave", id: `leave:${change.id}`, agent: change });
      }
    },
  });

  watch(input.scope, () => {
    queue.clear();
    presenceLines.value = [];
  });

  // A GitHub update joins the line once; when its source drops it, it leaves.
  let previewIds = new Set<string>();
  watch(() => input.eventPreviews(), (previews) => {
    const next = new Set(previews.map((preview) => preview.id));
    for (const id of previewIds) if (!next.has(id)) queue.remove(`github:${id}`);
    for (const preview of previews) {
      if (!previewIds.has(preview.id)) queue.push({ kind: "github", id: `github:${preview.id}`, preview });
    }
    previewIds = next;
  }, { immediate: true });

  watch(() => input.drafting(), (drafting) => {
    queue.setEligible((item) => !(drafting && item.kind === "github"));
  }, { immediate: true });

  onScopeDispose(() => queue.clear());

  return {
    notice,
    presenceLines,
    pause: () => queue.pause(),
    resume: () => queue.resume(),
    confirmSteer(displayName) {
      queue.pushFirst({ kind: "steered", id: `steered:${sequence += 1}`, displayName });
    },
  };
}
