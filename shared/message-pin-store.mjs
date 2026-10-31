import { isPinMessageId, MESSAGE_PIN_LIMIT } from "./message-pins.mjs";

/** One authoritative, bounded room list. All async work is fenced by context. */
export function createMessagePinStore(options) {
  let epoch = 0;
  let generation = 0;
  let context = null;
  let disposed = false;
  let reading = null;
  let queued = false;
  let mutation = null;
  let state = { pins: [], available: false, loading: false, pending: null, error: null };
  const changed = () => options.onChange?.(state);
  function reset(next = null) {
    epoch++;
    generation++;
    context = next;
    reading = null;
    mutation = null;
    queued = false;
    state = { pins: [], available: false, loading: false, pending: null, error: null };
    changed();
    if (next && !disposed) void refresh();
  }
  async function refresh() {
    if (!context || disposed) return;
    if (reading || mutation) { queued = true; return reading ?? mutation; }
    const ownEpoch = epoch;
    const ownGeneration = generation;
    const ownContext = context;
    state = { ...state, loading: true };
    changed();
    const job = Promise.resolve().then(async () => {
      if (ownEpoch !== epoch || disposed) return;
      try {
        const response = await options.load(ownContext);
        if (ownEpoch !== epoch || ownGeneration !== generation || disposed) return;
        const seen = new Set();
        const pins = (response.pins ?? []).filter((pin) => {
          if (!isPinMessageId(pin.message_id) || seen.has(pin.message_id)) return false;
          seen.add(pin.message_id);
          return true;
        }).slice(0, MESSAGE_PIN_LIMIT);
        state = { ...state, pins, available: response.available !== false, error: null, pending: null };
      } catch (error) {
        if (ownEpoch === epoch && ownGeneration === generation && !disposed) {
          state = { ...state, pending: null, error: error instanceof Error ? error.message : "Pins could not be loaded." };
        }
      } finally {
        if (ownEpoch === epoch && !disposed) {
          reading = null;
          state = { ...state, loading: false };
          changed();
          if (queued && !mutation) { queued = false; void refresh(); }
        }
      }
    });
    reading = job;
    return job;
  }
  async function setPinned(messageId, pinned) {
    if (disposed || !context || !state.available || mutation || state.pending || !isPinMessageId(messageId)) return;
    const ownEpoch = epoch;
    const ownContext = context;
    // A read started before this write is no longer authoritative.
    generation++;
    state = { ...state, pending: messageId, error: null };
    changed();
    const job = Promise.resolve().then(async () => {
      if (ownEpoch !== epoch || disposed) return;
      let succeeded = false;
      try {
        await options.mutate(ownContext, messageId, pinned);
        succeeded = true;
      } catch (error) {
        if (ownEpoch === epoch && !disposed) {
          const message = error instanceof Error ? error.message : "Pins could not be saved.";
          state = { ...state, error: message };
          options.onError?.(message);
        }
      } finally {
        if (ownEpoch === epoch && !disposed) {
          mutation = null;
          state = { ...state, pending: succeeded ? messageId : null };
          changed();
        }
      }
      if (ownEpoch === epoch && !disposed && (succeeded || queued)) {
        // If an older read is still running it must finish before the repair.
        queued = false;
        await refresh();
      }
    });
    mutation = job;
    return job;
  }
  return {
    get state() { return state; },
    reset, refresh, setPinned,
    dispose() { disposed = true; reset(); },
  };
}
