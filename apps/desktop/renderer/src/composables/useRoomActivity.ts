import { onScopeDispose, shallowRef, watch, type Ref } from "vue";
import type { DesktopAgentPresence } from "../../../electron/ipc-types";
import type { ComposerEventPreview } from "../components/desktop/content/room-chat/composer-event-preview";
import {
  createActivityNoticeQueue,
  type ActivityNotice,
  type CalmNoticeInput,
} from "../components/desktop/content/room-chat/room-activity";
import { useAgentPresenceChips } from "./useAgentPresenceChips";

/**
 * The notices on a room's activity line: agents joining and leaving, GitHub
 * updates, and feedback about the person's own actions. GitHub updates wait
 * while someone is writing.
 */
export function useRoomActivity(input: {
  presence: () => readonly DesktopAgentPresence[];
  scope: () => string | null;
  ready: () => boolean;
  eventPreviews: () => readonly ComposerEventPreview[];
  drafting: () => boolean;
}): {
  notice: Ref<ActivityNotice | null>;
  pause(): void;
  resume(): void;
  confirmSteer(displayName: string): void;
  calm(notice: CalmNoticeInput): void;
} {
  const notice = shallowRef<ActivityNotice | null>(null);
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
      for (const change of changes) {
        queue.push(change.kind === "connected"
          ? { kind: "join", id: `join:${change.id}`, agents: [change] }
          : { kind: "leave", id: `leave:${change.id}`, agent: change });
      }
    },
  });

  watch(input.scope, () => queue.clear());

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
    pause: () => queue.pause(),
    resume: () => queue.resume(),
    confirmSteer(displayName) {
      queue.pushFirst({ kind: "steered", id: `steered:${sequence += 1}`, displayName });
    },
    /** A calm line about the person's own action: an approval outcome or a file that did not attach. */
    calm(notice) {
      queue.pushFirst({ ...notice, kind: "calm", id: `calm:${sequence += 1}` });
    },
  };
}
