/**
 * The server keeps only a hash of each link, so this device remembers the
 * links it created to offer "Copy link" again later. Losing it is harmless:
 * the asker can cancel and ask again.
 */
const KEY = "letagents-desktop:agent-ask-links";

function read(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, string>; } catch { return {}; }
}

export function rememberAskLink(askId: string, link: string): void {
  try { localStorage.setItem(KEY, JSON.stringify({ ...read(), [askId]: link })); } catch { /* storage unavailable */ }
}

export function askLinkFor(askId: string): string | null {
  return read()[askId] ?? null;
}

export { AMOUNT_CHOICES, parseCustomAmount } from "../../../../../../../../shared/ui/give-agent/types";
