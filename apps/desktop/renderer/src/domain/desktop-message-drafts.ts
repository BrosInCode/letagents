import { computed, reactive, ref } from "vue";
import type { DesktopRoomMessage } from "../../../electron/ipc-types";
import { normalizeRoomIdentifier } from "./sidebar-rooms";

export interface DesktopDraftQuote extends DesktopRoomMessage {
  isSelection?: boolean;
  sourceMessageId?: string | null;
}
interface MessageDraft {
  text: string;
  textRevision: number;
  quote: DesktopDraftQuote | null;
  selectedQuoteText: string | null;
}

// Renderer-session state only: drafts survive room component eviction, but no
// upload handles or message bodies are written to disk.
const drafts = reactive(new Map<string, MessageDraft>());
const account = ref<string | null>(null);
let generation = 0;
let revision = 0;

export function clearDesktopMessageDrafts(): void {
  generation += 1;
  drafts.clear();
}

export function setDesktopMessageDraftAccount(accountId: string | null): void {
  if (account.value === accountId) return;
  clearDesktopMessageDrafts();
  account.value = accountId;
}

export function useDesktopMessageDraft(namespace: () => string | null, threadRootId: () => string | null = () => null) {
  const key = computed(() => JSON.stringify([account.value, normalizeRoomIdentifier(namespace()), threadRootId()]));
  const empty = (): MessageDraft => ({ text: "", textRevision: 0, quote: null, selectedQuoteText: null });
  const current = () => drafts.get(key.value) ?? empty();
  function update(patch: Partial<MessageDraft>, draftKey = key.value): void {
    const next = { ...(drafts.get(draftKey) ?? empty()), ...patch };
    if (!next.text && !next.quote && !next.selectedQuoteText) drafts.delete(draftKey);
    else drafts.set(draftKey, next);
  }
  const text = computed({
    get: () => current().text,
    set: (value: string) => update({ text: value, textRevision: ++revision }),
  });
  const quote = computed({
    get: () => current().quote,
    set: (value: DesktopDraftQuote | null) => update({ quote: value ? {
      id: value.id, sender: value.sender, text: value.text, source: value.source,
      timestamp: value.timestamp, agentPromptKind: value.agentPromptKind, actorLabel: value.actorLabel,
      threadRootId: value.threadRootId, threadReplyToId: null, thread: null, replyTo: null,
      agentIdentity: value.agentIdentity,
      displayText: value.displayText || (!value.text && value.attachments.length
        ? `${value.attachments.length} attachment${value.attachments.length === 1 ? "" : "s"}` : undefined),
      attachments: [], isSelection: value.isSelection, sourceMessageId: value.sourceMessageId,
    } : null }),
  });
  const selectedQuoteText = computed({
    get: () => current().selectedQuoteText,
    set: (value: string | null) => update({ selectedQuoteText: value }),
  });
  function captureSubmittedText(): () => boolean {
    const submittedKey = key.value;
    const submittedGeneration = generation;
    const submittedRevision = current().textRevision;
    return () => {
      if (generation !== submittedGeneration || drafts.get(submittedKey)?.textRevision !== submittedRevision) return false;
      update({ text: "", textRevision: ++revision }, submittedKey);
      return true;
    };
  }
  return { text, quote, selectedQuoteText, captureSubmittedText };
}
