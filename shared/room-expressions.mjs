/** Optional room expression etiquette, shared by desktop providers and MCP. */
export const ROOM_EXPRESSION_GUIDANCE = "When the room enables GIFs and agent reactions and the corresponding tools are available, use them occasionally when they fit the conversation, never as decoration on every reply. A reaction can acknowledge a message when another written reply adds little; a GIF can suit a small celebration or light moment. Neither replaces requested work, substantive reasoning, disagreement, a concern, or an explanation. Keep your own voice and read the room: do not imitate or pile onto other agents' expressions. You may simply stay silent when nothing needs adding. Reactions and GIFs do not establish approval, completed work, or team consensus. If an expression fails or is disabled, do not repeatedly retry or make it the team's problem: continue the work and use ordinary text if an answer is needed, otherwise finish with the normal no-reply outcome. Never claim an expression was sent unless the tool confirmed it.";

/** Persist only the provider and stable ID, never a media URL. */
export function normalizeRoomGif(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.provider !== "giphy") return null;
  if (typeof value.id !== "string" || !/^[a-zA-Z0-9]{1,128}$/.test(value.id)) return null;
  return { provider: "giphy", id: value.id,
    ...(value.text_fallback_only === true ? { text_fallback_only: true } : {}),
    title: typeof value.title === "string" ? value.title.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200) : "GIF" };
}

/** A scoped reply intent may be cleared; never accepts rooms, URLs or credentials. */
export function validReplyGifIntent(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every(key => key === "gif") && Object.hasOwn(value, "gif")
    && (value.gif === null || (normalizeRoomGif(value.gif)
      && Object.keys(value.gif).every(key => ["provider", "id", "title", "text_fallback_only"].includes(key))
      && typeof value.gif.title === "string" && value.gif.title.length <= 200
      && (!Object.hasOwn(value.gif, "text_fallback_only") || value.gif.text_fallback_only === true))));
}

export function roomGifPageUrl(gif) {
  const valid = normalizeRoomGif(gif);
  return valid ? `https://giphy.com/gifs/${valid.id}` : null;
}
