import { createHash } from "node:crypto";

import { assertValidOpenModelBaseUrl } from "./open-model-settings.js";

/**
 * The reasoning efforts an Open Model agent can be given. They are the values
 * the daemon stores and OpenCode passes on as `reasoning_effort`. OpenRouter
 * also lists "minimal" and "none" for some models; the daemon does not store
 * them, so they are never offered. "max" is a Claude value, not one an
 * OpenAI-compatible endpoint takes.
 */
export const OPEN_MODEL_REASONING_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
export type OpenModelReasoningEffort = typeof OPEN_MODEL_REASONING_EFFORTS[number];

export function isOpenModelReasoningEffort(value: unknown): value is OpenModelReasoningEffort {
  return typeof value === "string" && (OPEN_MODEL_REASONING_EFFORTS as readonly string[]).includes(value);
}

/**
 * The efforts each model of one `/models` answer lists, by model id. Only
 * OpenRouter's `reasoning.supported_efforts` shape is read: an endpoint that
 * answers in any other shape, or a model without that field, supports none.
 */
export function parseOpenModelSupportedEfforts(body: unknown): Map<string, OpenModelReasoningEffort[]> {
  const efforts = new Map<string, OpenModelReasoningEffort[]>();
  const data = body && typeof body === "object" ? (body as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) return efforts;
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const { id, reasoning } = item as { id?: unknown; reasoning?: unknown };
    if (typeof id !== "string" || !id || efforts.has(id)) continue;
    const listed = reasoning && typeof reasoning === "object"
      ? (reasoning as { supported_efforts?: unknown }).supported_efforts
      : undefined;
    if (!Array.isArray(listed)) continue;
    const supported = OPEN_MODEL_REASONING_EFFORTS.filter((effort) => listed.includes(effort));
    if (supported.length) efforts.set(id, supported);
  }
  return efforts;
}

type CatalogCacheEntry = { expiresAt: number; efforts: Promise<Map<string, OpenModelReasoningEffort[]>> };

const CATALOG_CACHE_MS = 5 * 60_000;
const CATALOG_ERROR_CACHE_MS = 15_000;
const CATALOG_CACHE_LIMIT = 16;
const catalogCache = new Map<string, CatalogCacheEntry>();

/** Test-only: forget every remembered `/models` answer. */
export function clearOpenModelEffortCatalogCacheForTest(): void {
  catalogCache.clear();
}

/**
 * The efforts the endpoint lists for each of its models, from the same
 * `/models` request the context limits use. An answer is kept for a few
 * minutes per endpoint and key, unless a refresh asks again; a failed one,
 * as no support, for less.
 * Errors are never thrown: an endpoint that cannot be read supports none.
 */
export async function resolveOpenModelEffortCatalog(
  input: { baseUrl: string; apiKey: string | null; refresh?: boolean },
  fetchModels: (url: string, init?: RequestInit) => Promise<Response> = fetch,
  now: () => number = Date.now,
): Promise<Map<string, OpenModelReasoningEffort[]>> {
  try {
    assertValidOpenModelBaseUrl(input.baseUrl);
  } catch {
    return new Map();
  }
  // The key is hashed so the cache never holds it in a readable form.
  const cacheKey = createHash("sha256").update(`${input.baseUrl}\u0000${input.apiKey ?? ""}`).digest("hex");
  const cached = catalogCache.get(cacheKey);
  if (!input.refresh && cached && cached.expiresAt > now()) return new Map(await cached.efforts);
  const entry: CatalogCacheEntry = { expiresAt: now() + CATALOG_CACHE_MS, efforts: Promise.resolve(new Map()) };
  entry.efforts = (async () => {
    const url = new URL(input.baseUrl);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/models`;
    try {
      const response = await fetchModels(url.href, {
        headers: input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {},
        signal: AbortSignal.timeout(5_000), redirect: "error",
      });
      if (response.ok) return parseOpenModelSupportedEfforts(await response.json());
    } catch {
      // Endpoint errors can contain credentials; no support is the safe answer.
    }
    entry.expiresAt = now() + CATALOG_ERROR_CACHE_MS;
    return new Map();
  })();
  catalogCache.delete(cacheKey);
  for (const key of catalogCache.keys()) {
    if (catalogCache.size < CATALOG_CACHE_LIMIT) break;
    catalogCache.delete(key);
  }
  catalogCache.set(cacheKey, entry);
  return new Map(await entry.efforts);
}
