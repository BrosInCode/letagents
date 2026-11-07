export function parseCompanyLink(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "letagents:" || url.hostname !== "join" || url.port || url.username || url.password || url.search || url.hash) return null;
    const match = /^\/([1-9][0-9]*)$/.exec(url.pathname);
    return match?.[1] ?? null;
  } catch { return null; }
}
