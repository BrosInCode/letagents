// Pure helper for the message context menu's link actions. Given an anchor's
// raw href and the document base URL, resolve it to an absolute http/https URL
// suitable for "Open link in browser" / "Copy link", or null when the target
// is not an external web link (mailto:, in-app anchors, javascript:, garbage).
// Kept out of the component so it can be unit-tested without a DOM.

export function resolveExternalWebHref(
  rawHref: string | null | undefined,
  baseUrl: string,
): string | null {
  if (!rawHref) return null;
  let url: URL;
  try {
    url = new URL(rawHref, baseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.toString();
}
