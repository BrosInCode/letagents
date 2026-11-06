import type { InjectionKey, Ref } from 'vue';
import type { GitHubChatHighlight } from '../grouped-github-updates';

/** Chat uses the room's existing Activity state and navigation on both clients. */
export const roomGitHubActivityKey: InjectionKey<{
  highlights: Readonly<Ref<readonly GitHubChatHighlight[]>>;
  available: Readonly<Ref<boolean>>;
  open: (url?: string, eventId?: string | null) => void;
}> = Symbol('room-github-activity');
