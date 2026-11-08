export function parseCompanyLink(value: string): string | null {
  try {
    const url = new URL(value);
    // letagents://company/<id>, the app half of the https://…/company/<id> page.
    if (url.protocol !== "letagents:" || url.hostname !== "company" || url.port || url.username || url.password || url.search || url.hash) return null;
    const match = /^\/([1-9][0-9]*)$/.exec(url.pathname);
    return match?.[1] ?? null;
  } catch { return null; }
}
