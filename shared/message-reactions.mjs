// Emoji reactions on room messages: the limits, the quick palette and the one
// validation rule that the server and both clients share.

export const MESSAGE_REACTION_EMOJI_MAX_BYTES = 64;
export const MESSAGE_REACTION_MAX_DISTINCT_PER_MESSAGE = 20;
// A reaction always reports its exact count; only the named reactors are capped.
export const MESSAGE_REACTION_MAX_REACTORS_LISTED = 50;
// One range read covers at most this many message numbers, and returns at most
// this many reactor rows before it stops and names where to continue.
export const MESSAGE_REACTION_RANGE_MAX_SPAN = 1000;
export const MESSAGE_REACTION_MAX_PER_READ = 2000;

export const MESSAGE_REACTION_QUICK_EMOJI = Object.freeze([
  "👍", "👎", "✅", "❌", "👀", "🙏", "🎉", "🚀",
  "❤️", "😂", "🤔", "😅", "🔥", "💯", "👏", "🙌",
  "🤝", "⚠️", "🐛", "🔧", "📌", "⏳", "💡", "❓",
]);

const VARIATION_SELECTOR_16 = "️";
const encoder = new TextEncoder();

// `\p{RGI_Emoji}` needs the `v` flag, which every runtime we ship has. The
// fallback keeps an older browser usable; the server stays the authority.
const emojiPattern = (() => {
  try {
    return new RegExp("^\\p{RGI_Emoji}$", "v");
  } catch {
    return /^(?:\p{Regional_Indicator}{2}|[#*0-9]️?⃣|\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?(?:‍\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?)*)$/u;
  }
})();

/**
 * Return the canonical form of one emoji, or null when the value is anything
 * else (text, several emoji, an oversized sequence).
 */
export function normalizeMessageReactionEmoji(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || encoder.encode(trimmed).length > MESSAGE_REACTION_EMOJI_MAX_BYTES) return null;
  if (emojiPattern.test(trimmed)) return trimmed;
  // A bare text-style symbol such as "❤" is the same reaction as "❤️".
  const qualified = `${trimmed}${VARIATION_SELECTOR_16}`;
  return emojiPattern.test(qualified) ? qualified : null;
}

function normalizeReactor(value) {
  if (!value || typeof value !== "object") return null;
  const login = typeof value.login === "string" ? value.login.trim() : "";
  if (!login || login.length > 256) return null;
  const name = typeof value.name === "string" && value.name.trim() ? value.name.trim().slice(0, 256) : login;
  const avatarUrl = typeof value.avatar_url === "string" && /^https:\/\//.test(value.avatar_url)
    ? value.avatar_url.slice(0, 2048)
    : null;
  return { login, name, avatar_url: avatarUrl };
}

/**
 * Read a server reaction list defensively. Anything malformed is dropped, so a
 * client never renders a reaction it could not also send.
 */
export function normalizeMessageReactions(value) {
  if (!Array.isArray(value)) return [];
  const reactions = [];
  const seen = new Set();
  for (const item of value) {
    if (reactions.length >= MESSAGE_REACTION_MAX_DISTINCT_PER_MESSAGE) break;
    if (!item || typeof item !== "object") continue;
    const emoji = normalizeMessageReactionEmoji(item.emoji);
    if (!emoji || seen.has(emoji)) continue;
    const reactors = (Array.isArray(item.reactors) ? item.reactors : [])
      .slice(0, MESSAGE_REACTION_MAX_REACTORS_LISTED)
      .map(normalizeReactor)
      .filter(Boolean);
    const count = Number.isSafeInteger(item.count) && item.count > 0 ? item.count : reactors.length;
    if (count <= 0) continue;
    seen.add(emoji);
    reactions.push({ emoji, count: Math.max(count, reactors.length), reactors });
  }
  return reactions;
}

function sameLogin(left, right) {
  return typeof left === "string" && typeof right === "string"
    && left.length > 0 && left.toLowerCase() === right.toLowerCase();
}

/** Whether the listed reactors include the viewer. */
export function viewerReactedWith(reaction, viewerLogin) {
  return Boolean(reaction?.reactors?.some((reactor) => sameLogin(reactor.login, viewerLogin)));
}

/** "You, Ada and 3 others reacted with 👍" — the tooltip and the accessible name. */
export function describeMessageReaction(reaction, viewerLogin) {
  const reactors = Array.isArray(reaction?.reactors) ? reaction.reactors : [];
  const viewerReacted = viewerReactedWith(reaction, viewerLogin);
  const names = [
    ...(viewerReacted ? ["You"] : []),
    ...reactors.filter((reactor) => !sameLogin(reactor.login, viewerLogin)).map((reactor) => reactor.name),
  ];
  const count = Math.max(Number(reaction?.count) || 0, names.length);
  const shown = names.slice(0, 3);
  const others = count - shown.length;
  if (others > 0) shown.push(others === 1 ? "1 other" : `${others} others`);
  const who = shown.length <= 1
    ? shown[0] ?? "Someone"
    : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
  return `${who} reacted with ${reaction?.emoji ?? ""}`.trim();
}

/**
 * The reaction list after the viewer toggles one emoji, for an optimistic
 * update. The server's answer replaces it either way.
 */
export function toggleViewerMessageReaction(reactions, emoji, viewer) {
  const current = Array.isArray(reactions) ? reactions : [];
  const existing = current.find((reaction) => reaction.emoji === emoji);
  if (!existing) {
    return [...current, { emoji, count: 1, reactors: [{ ...viewer }] }];
  }
  if (viewerReactedWith(existing, viewer.login)) {
    const reactors = existing.reactors.filter((reactor) => !sameLogin(reactor.login, viewer.login));
    const count = existing.count - 1;
    return count <= 0
      ? current.filter((reaction) => reaction !== existing)
      : current.map((reaction) => (reaction === existing ? { ...existing, count, reactors } : reaction));
  }
  return current.map((reaction) => (reaction === existing
    ? { ...existing, count: existing.count + 1, reactors: [...existing.reactors, { ...viewer }] }
    : reaction));
}
