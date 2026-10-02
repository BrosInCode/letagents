// The client-side state of a room's reactions, shared by the desktop and web
// apps. It is framework-free: the app supplies the two API calls and is told
// when something changed.
//
// A message on screen registers itself with `track`. Its reactions start from
// what the message carried when it was read, so nothing shifts as the room
// opens, and are then confirmed by a read of the server: shortly after a
// message is first tracked, and whenever the app calls `refresh` because the
// room reported a `message_reactions` invalidation or its stream reconnected.
import {
  MESSAGE_REACTION_RANGE_MAX_SPAN,
  normalizeMessageReactionEmoji,
  normalizeMessageReactions,
  toggleViewerMessageReaction,
  viewerReactedWith,
} from "./message-reactions.mjs";

const NONE = Object.freeze([]);

function messageNumber(id) {
  const match = /^msg_([1-9]\d*)$/.exec(typeof id === "string" ? id : "");
  return match ? Number(match[1]) : null;
}

function sameReactions(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Split sorted message numbers into runs the server will read in one request. */
function spans(numbers) {
  const runs = [];
  for (const number of numbers) {
    const run = runs.at(-1);
    if (run && number - run.first < MESSAGE_REACTION_RANGE_MAX_SPAN) run.last = number;
    else runs.push({ first: number, last: number });
  }
  return runs;
}

export function createMessageReactionStore({ load, mutate, viewer, onChange, onError, refreshDelayMs = 50 }) {
  let reactions = new Map();
  // Which emoji the viewer reacted with, per message, once the server said so.
  // Until then the listed reactors answer, which can miss a viewer past the cap.
  let viewerEmoji = new Map();
  // Messages whose own `reactions` were already taken; a later copy of the
  // same message may be older than what a read has since learned.
  let seeded = new Set();
  // One chain of toggles per message, so rapid clicks reach the server in order.
  let pending = new Map();
  // Messages on screen: id -> the message and one token per registration.
  let tracked = new Map();
  // Orders the viewer's own changes against reads that began before them.
  let mutationSeq = 0;
  let lastMutation = new Map();
  // Answers on their way are dropped when `epoch` moves; registrations made
  // before `trackingEpoch` moved no longer own anything.
  let epoch = 0;
  let trackingEpoch = 0;
  let refreshing = null;
  let refreshTimer = null;

  function store(messageId, next) {
    if (sameReactions(reactions.get(messageId) ?? NONE, next)) return false;
    if (next.length) reactions.set(messageId, next);
    else reactions.delete(messageId);
    return true;
  }

  function get(messageId) {
    return reactions.get(messageId) ?? NONE;
  }

  function viewerReacted(messageId, emoji) {
    const known = viewerEmoji.get(messageId);
    if (known) return known.has(emoji);
    return viewerReactedWith(get(messageId).find((reaction) => reaction.emoji === emoji), viewer()?.login);
  }

  function seed(message) {
    const id = message?.id;
    if (messageNumber(id) === null || seeded.has(id)) return false;
    seeded.add(id);
    if (pending.has(id)) return false;
    return store(id, normalizeMessageReactions(message.reactions));
  }

  function scheduleRefresh() {
    if (refreshTimer !== null) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void refresh();
    }, refreshDelayMs);
  }

  /**
   * A rendered message registers itself; the returned function unregisters it.
   * The first registration of a message also asks the server, a moment later
   * and together with every other message registered meanwhile: the copy on
   * screen may predate a change that happened while the message was not shown.
   */
  function track(message) {
    const id = message?.id;
    if (messageNumber(id) === null) return () => {};
    const registeredIn = trackingEpoch;
    const token = Symbol("tracked");
    const entry = tracked.get(id);
    if (entry) {
      entry.tokens.add(token);
      entry.message = message;
    } else {
      tracked.set(id, { message, tokens: new Set([token]) });
      if (seed(message)) onChange?.();
      scheduleRefresh();
    }
    return () => {
      if (registeredIn !== trackingEpoch) return;
      const current = tracked.get(id);
      if (!current?.tokens.delete(token) || current.tokens.size > 0) return;
      tracked.delete(id);
    };
  }

  async function readSpan(first, last, startedIn, startedAtMutation) {
    let from = first;
    // Every continuation advances within a span of at most 1,000 messages.
    // An arbitrary page cap would permanently starve dense ranges' tails.
    while (from <= last) {
      let changed = false;
      const read = await load(`msg_${from}`, `msg_${last}`);
      // The room changed while this read was in flight.
      if (startedIn !== epoch) return;
      const byMessage = read?.reactions && typeof read.reactions === "object" ? read.reactions : {};
      const viewerByMessage = read?.viewer_reactions && typeof read.viewer_reactions === "object"
        ? read.viewer_reactions
        : null;
      // A read the server cut short is complete only below the message it names.
      const next = messageNumber(read?.next_first_message_id);
      const completeBelow = next !== null && next > from ? next : last + 1;
      for (const [id] of tracked) {
        const number = messageNumber(id);
        if (number < from || number >= completeBelow) continue;
        // The viewer changed this message after the read began: the read is older.
        if (pending.has(id) || (lastMutation.get(id) ?? 0) > startedAtMutation) continue;
        seeded.add(id);
        if (store(id, normalizeMessageReactions(byMessage[id]))) changed = true;
        if (viewerByMessage) {
          const mine = new Set((Array.isArray(viewerByMessage[id]) ? viewerByMessage[id] : [])
            .map(normalizeMessageReactionEmoji)
            .filter(Boolean));
          const known = viewerEmoji.get(id);
          if (!known || known.size !== mine.size || [...mine].some((emoji) => !known.has(emoji))) changed = true;
          viewerEmoji.set(id, mine);
        }
      }
      // Publish completed pages even if a later page fails or is slow.
      if (changed) onChange?.();
      if (next === null || next <= from) break;
      from = next;
    }
  }

  /**
   * Re-read the reactions of every message on screen. Calls made while a read
   * is in flight collapse into one follow-up read.
   */
  function refresh() {
    if (refreshTimer !== null) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    if (refreshing) {
      refreshing.again = true;
      return refreshing.promise;
    }
    const startedIn = epoch;
    const cycle = { again: false, promise: null };
    refreshing = cycle;
    cycle.promise = (async () => {
      do {
        cycle.again = false;
        const startedAtMutation = mutationSeq;
        const numbers = Array.from(tracked.keys(), messageNumber).sort((left, right) => left - right);
        try {
          for (const span of spans(numbers)) {
            if (startedIn !== epoch) break;
            await readSpan(span.first, span.last, startedIn, startedAtMutation);
          }
        } catch (error) {
          // Keep what is shown; the next invalidation reads again.
          if (startedIn === epoch) onError?.(error, "load");
        }
      } while (cycle.again && startedIn === epoch);
    })().finally(() => {
      if (refreshing === cycle) refreshing = null;
    });
    return cycle.promise;
  }

  /** Add the viewer's reaction, or remove it if it is already there. */
  function toggle(messageId, emoji) {
    const person = viewer();
    if (!person || messageNumber(messageId) === null) return Promise.resolve();
    const startedIn = epoch;

    const run = async () => {
      if (startedIn !== epoch) return;
      const before = get(messageId);
      const mineBefore = viewerEmoji.get(messageId);
      const listed = viewerReactedWith(before.find((reaction) => reaction.emoji === emoji), person.login);
      const reacted = mineBefore ? mineBefore.has(emoji) : listed;
      // A viewer the list does not name can only lower or raise the count.
      const optimistic = reacted === listed
        ? toggleViewerMessageReaction(before, emoji, person)
        : before
          .map((reaction) => (reaction.emoji === emoji ? { ...reaction, count: reaction.count + (reacted ? -1 : 1) } : reaction))
          .filter((reaction) => reaction.count > 0);
      const mineOptimistic = new Set(mineBefore ?? before
        .filter((reaction) => viewerReactedWith(reaction, person.login))
        .map((reaction) => reaction.emoji));
      if (reacted) mineOptimistic.delete(emoji);
      else mineOptimistic.add(emoji);

      lastMutation.set(messageId, ++mutationSeq);
      store(messageId, optimistic);
      viewerEmoji.set(messageId, mineOptimistic);
      onChange?.();
      try {
        const result = await mutate(messageId, emoji, !reacted);
        if (startedIn !== epoch) return;
        lastMutation.set(messageId, ++mutationSeq);
        seeded.add(messageId);
        // The server's list may hold what others did meanwhile; whether the
        // viewer reacted is exactly what was just asked for.
        store(messageId, normalizeMessageReactions(result?.reactions));
        onChange?.();
        // An invalidation read may have been skipped while this write was
        // pending. Confirm all viewer emoji too (another tab may change them).
        scheduleRefresh();
      } catch (error) {
        if (startedIn !== epoch) return;
        lastMutation.set(messageId, ++mutationSeq);
        store(messageId, before);
        if (mineBefore) viewerEmoji.set(messageId, mineBefore);
        else viewerEmoji.delete(messageId);
        onChange?.();
        onError?.(error, "mutate");
        // A read that landed during the attempt was skipped for this message.
        scheduleRefresh();
      }
    };

    const queued = (pending.get(messageId) ?? Promise.resolve()).then(run);
    const settled = queued.finally(() => {
      if (pending.get(messageId) === settled) pending.delete(messageId);
    });
    pending.set(messageId, settled);
    return settled;
  }

  /**
   * Forget everything. With `keepTracked`, the messages on screen stay
   * registered and start again from what they carried (the signed-in person
   * changed); without it they are dropped too (the room changed).
   */
  function reset({ keepTracked = false } = {}) {
    const hadAny = reactions.size > 0 || viewerEmoji.size > 0;
    // Answers on their way belong to the previous room or person.
    epoch += 1;
    // A stalled old-room read must not delay the next room or viewer. Its
    // eventual cleanup owns only its own cycle, never the new refresh.
    refreshing = null;
    reactions = new Map();
    viewerEmoji = new Map();
    seeded = new Set();
    lastMutation = new Map();
    pending = new Map();
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    refreshTimer = null;
    if (keepTracked) {
      for (const entry of tracked.values()) seed(entry.message);
      if (tracked.size) scheduleRefresh();
    } else {
      trackingEpoch += 1;
      tracked = new Map();
    }
    if (hadAny || tracked.size) onChange?.();
  }

  return { get, viewerReacted, track, refresh, toggle, reset };
}
