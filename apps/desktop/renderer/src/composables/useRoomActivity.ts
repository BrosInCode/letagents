import { onScopeDispose, shallowRef, watch, type Ref } from "vue";
import type { ComposerEventPreview } from "../components/desktop/content/room-chat/composer-event-preview";
import {
  createActivityNoticeQueue,
  type ActivityNotice,
  type CalmNoticeInput,
} from "../components/desktop/content/room-chat/room-activity";

/** GitHub updates and confirmations on the room activity line. */
export function useRoomActivity(input: {
  scope: () => string | null;
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

  watch(input.scope, () => {
    queue.clear();
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
