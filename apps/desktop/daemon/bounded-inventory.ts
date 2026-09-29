const DEFAULT_MAX_PAGES = 100;
const DEFAULT_MAX_IDENTITIES = 10_000;

export async function collectBoundedInventory(
  readPage: (after: string | null) => Promise<{ ids: readonly string[]; nextCursor: string | null }>,
  label: string,
  seed: readonly string[] = [],
  limits: { maxPages?: number; maxIdentities?: number } = {},
): Promise<string[]> {
  const maxPages = limits.maxPages ?? DEFAULT_MAX_PAGES;
  const maxIdentities = limits.maxIdentities ?? DEFAULT_MAX_IDENTITIES;
  const ids = new Set(seed);
  if (ids.size > maxIdentities) throw new Error(`${label} exceeded ${maxIdentities} identities.`);
  const seenCursors = new Set<string>();
  let after: string | null = null;
  let pageCount = 0;
  do {
    const page = await readPage(after);
    pageCount += 1;
    for (const id of page.ids) ids.add(id);
    if (ids.size > maxIdentities) throw new Error(`${label} exceeded ${maxIdentities} identities.`);
    if (page.nextCursor !== null && (page.nextCursor === after || seenCursors.has(page.nextCursor))) {
      throw new Error(`${label} cursor did not advance.`);
    }
    if (page.nextCursor !== null && pageCount >= maxPages) {
      throw new Error(`${label} exceeded ${maxPages} pages.`);
    }
    after = page.nextCursor;
    if (after !== null) seenCursors.add(after);
  } while (after !== null);
  return [...ids].sort();
}
