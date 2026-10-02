import { LINK_PREVIEW_BATCH_LIMIT, linkPreviewKey } from "./message-link-previews.mjs";

/** Separate from messages: one bounded read chain for the references rendered in a room. */
export function createMessageLinkPreviewStore({ load, onChange, refreshDelayMs = 50 }) {
  let epoch = 0;
  let tracked = new Map();
  let previews = new Map();
  let timer = null;
  let reading = null;
  function schedule() {
    if (timer !== null) return;
    timer = setTimeout(() => { timer = null; void refresh(); }, refreshDelayMs);
  }
  function track(message) {
    if (!message.references.length) return () => {};
    const token = Symbol();
    tracked.set(token, message);
    onChange?.();
    if (message.references.some((ref) => !previews.has(linkPreviewKey(ref)))) schedule();
    return () => {
      tracked.delete(token);
      const used = new Set([...tracked.values()].flatMap((entry) => entry.references.map(linkPreviewKey)));
      for (const key of previews.keys()) if (!used.has(key)) previews.delete(key);
    };
  }
  function get(messageId) {
    const message = [...tracked.values()].find((entry) => entry.id === messageId);
    return (message?.references ?? []).flatMap((ref) => previews.get(linkPreviewKey(ref)) ?? []);
  }
  function refresh() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (reading) { reading.again = true; return reading.promise; }
    const startedIn = epoch;
    const cycle = { again: false, promise: null };
    reading = cycle;
    cycle.promise = (async () => {
      do {
        cycle.again = false;
        const unique = new Map([...tracked.values()].flatMap((entry) => entry.references.map((ref) => [linkPreviewKey(ref), ref])));
        const references = [...unique.values()];
        for (let i = 0; i < references.length; i += LINK_PREVIEW_BATCH_LIMIT) {
          if (startedIn !== epoch) return;
          const batch = references.slice(i, i + LINK_PREVIEW_BATCH_LIMIT);
          try {
            const result = await load(batch);
            if (startedIn !== epoch) return;
            const values = new Map(result.previews.map((preview) => [linkPreviewKey(preview), preview]));
            let changed = false;
            const used = new Set([...tracked.values()].flatMap((entry) => entry.references.map(linkPreviewKey)));
            for (const ref of batch) {
              const key = linkPreviewKey(ref);
              if (!used.has(key)) continue;
              const next = values.get(key) ?? null;
              if (JSON.stringify(previews.get(key) ?? null) !== JSON.stringify(next)) changed = true;
              previews.set(key, next);
            }
            if (changed) onChange?.();
          } catch {
            // Retry on the next stream update, reconnect or registration.
          }
        }
      } while (cycle.again && startedIn === epoch);
    })().finally(() => { if (reading === cycle) reading = null; });
    return cycle.promise;
  }
  function reset() {
    epoch++;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    reading = null;
    tracked = new Map();
    previews = new Map();
    onChange?.();
  }
  return { track, get, refresh, reset };
}
