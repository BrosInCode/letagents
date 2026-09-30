import { computed, ref, watch } from "vue";
import type { DesktopBoardIntentSummary } from "../../../../../../electron/ipc-types";
import { denyIntentReason } from "./governance-presentation";

/** Where focus goes after the deny form changes: a request's reason field or Deny button, or the list. */
export type DenyFormFocusTarget =
  | { kind: "reason"; intentId: string }
  | { kind: "deny"; intentId: string }
  | { kind: "request"; intentId: string }
  | { kind: "list" };

/**
 * Deny with an optional reason. A typed reason is kept per request until it is
 * sent or cancelled, and survives a failed request. When a denied request
 * leaves the list, focus moves to the request that took its place.
 */
export function useGovernanceDenyForm(options: {
  intents: () => readonly DesktopBoardIntentSummary[];
  busy: () => boolean;
  deny: (intentId: string, reason: string | null) => void;
  focus: (target: DenyFormFocusTarget) => void;
}) {
  const denyingIntentId = ref<string | null>(null);
  const reasons = ref<Record<string, string>>({});
  let submittedIndex: number | null = null;

  const reason = computed({
    get: () => (denyingIntentId.value ? reasons.value[denyingIntentId.value] ?? "" : ""),
    set: (value: string) => {
      if (denyingIntentId.value) reasons.value = { ...reasons.value, [denyingIntentId.value]: value };
    },
  });

  watch(() => options.intents(), (intents) => {
    const openId = denyingIntentId.value;
    const stillPending = new Set(intents.map((intent) => intent.id));
    reasons.value = Object.fromEntries(Object.entries(reasons.value).filter(([id]) => stillPending.has(id)));
    if (!openId || stillPending.has(openId)) return;
    denyingIntentId.value = null;
    if (submittedIndex === null) return;
    const next = intents[Math.min(submittedIndex, intents.length - 1)];
    submittedIndex = null;
    options.focus(next ? { kind: "request", intentId: next.id } : { kind: "list" });
  }, { flush: "sync" });

  function start(intentId: string): void {
    denyingIntentId.value = intentId;
    submittedIndex = null;
    options.focus({ kind: "reason", intentId });
  }

  function cancel(): void {
    const intentId = denyingIntentId.value;
    if (!intentId || options.busy()) return;
    reasons.value = Object.fromEntries(Object.entries(reasons.value).filter(([id]) => id !== intentId));
    denyingIntentId.value = null;
    options.focus({ kind: "deny", intentId });
  }

  function submit(): void {
    const intentId = denyingIntentId.value;
    if (!intentId || options.busy()) return;
    submittedIndex = options.intents().findIndex((intent) => intent.id === intentId);
    options.deny(intentId, denyIntentReason(reason.value));
  }

  return { denyingIntentId, reason, start, cancel, submit };
}
