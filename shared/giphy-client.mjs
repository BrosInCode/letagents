import { normalizeRoomGif, roomGifPageUrl } from "./room-expressions.mjs";

const TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 2_000_000;

function failure(code, retryAfterMs = 0) {
  return { ok: false, code, retry_after_ms: retryAfterMs,
    message: code === "rate_limited" ? "GIF search is temporarily at its limit. You can send text instead."
      : code === "not_configured" ? "GIF search is not configured. You can send text instead."
      : code === "invalid_query" ? "Use a GIF search of 1–50 characters."
      : "GIFs are unavailable right now. You can send text instead." };
}

function mediaUrl(value) {
  if (typeof value !== "string" || value.length > 8192) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      && (url.hostname === "giphy.com" || url.hostname.endsWith(".giphy.com")) ? value : null;
  } catch { return null; }
}

function item(value) {
  const gif = normalizeRoomGif({ ...value, provider: "giphy" });
  if (!gif) throw new Error("invalid GIF");
  // Keep the provider's ordering and URLs intact; never persist these URLs.
  return { ...gif, page_url: roomGifPageUrl(gif),
    preview_url: mediaUrl(value.images?.fixed_height_small?.url ?? value.images?.fixed_height?.url),
    still_url: mediaUrl(value.images?.fixed_height_still?.url),
    image_url: mediaUrl(value.images?.downsized?.url ?? value.images?.fixed_height?.url),
  };
}

/** Runs on the user's client, never as a server proxy. No retries or media cache. */
export function createGiphyClient({ fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = TIMEOUT_MS } = {}) {
  // Only failure state is retained. Shared by calls in this client to prevent
  // every visible GIF/agent from hammering an exhausted provider allocation.
  let blockedKey = "";
  let blockedUntil = 0;
  let blockedCode = "unavailable";
  async function request(apiKey, suffix, params) {
    if (!apiKey?.trim()) return failure("not_configured");
    if (apiKey === blockedKey && now() < blockedUntil) return failure(blockedCode, blockedUntil - now());
    const url = new URL(`https://api.giphy.com/v1/gifs${suffix}`);
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("rating", "pg");
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const block = (code, duration) => {
      blockedKey = apiKey; blockedCode = code; blockedUntil = now() + duration;
      return failure(code, duration);
    };
    try {
      const response = await fetchImpl(url.toString(), { signal: controller.signal, cache: "no-store", redirect: "error", credentials: "omit" });
      if (response.status === 429) {
        const header = response.headers.get("retry-after");
        const seconds = header && /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header ?? "") - now();
        return block("rate_limited", Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3_600_000) : 60_000);
      }
      if (response.status === 401 || response.status === 403) return block("unavailable", 300_000);
      if (!response.ok) return block("unavailable", 15_000);
      const reader = response.body?.getReader();
      if (!reader) return block("unavailable", 15_000);
      const chunks = []; let bytes = 0;
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); return block("unavailable", 15_000); }
        chunks.push(value);
      }
      const joined = new Uint8Array(bytes); let offset = 0;
      for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
      const payload = JSON.parse(new TextDecoder().decode(joined));
      if (payload.meta?.status !== 200) return block("unavailable", 15_000);
      const data = Array.isArray(payload.data) ? payload.data : [payload.data];
      if (suffix !== "/search" && data.some(gif => !gif || !["g", "pg"].includes(gif.rating))) return failure("unavailable");
      if (data.length > 25) return block("unavailable", 15_000);
      return { ok: true, items: data.map(item),
        next_offset: payload.pagination && payload.pagination.offset + payload.pagination.count < payload.pagination.total_count
          ? payload.pagination.offset + payload.pagination.count : null };
    } catch {
      // Never return raw fetch errors: they can contain the API key in the URL.
      return block("unavailable", 15_000);
    } finally { clearTimeout(timer); }
  }
  return {
    search(apiKey, query, offset = 0) {
      if (typeof query !== "string" || !query.trim() || query.length > 50
        || !Number.isSafeInteger(offset) || offset < 0 || offset > 4999) return Promise.resolve(failure("invalid_query"));
      return request(apiKey, "/search", { q: query, limit: 12, offset });
    },
    resolve(apiKey, gifId) {
      if (!normalizeRoomGif({ provider: "giphy", id: gifId })) return Promise.resolve(failure("unavailable"));
      return request(apiKey, `/${gifId}`, {});
    },
  };
}
