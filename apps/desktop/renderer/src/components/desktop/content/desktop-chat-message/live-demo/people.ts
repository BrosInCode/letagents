import type { DesktopLiveDemoStatus } from "../../../../../../../electron/ipc-types";
import type { LiveDemoPerson } from "./protocol";

export interface PresenceChips {
  chips: Array<LiveDemoPerson & { self: boolean }>;
  /** People beyond the chips that fit. */
  more: number;
}

/**
 * The people on a demo, as chips: you first, then the others in the order the
 * server listed them. Nothing shows while you are the only one.
 */
export function presenceChips(
  people: readonly LiveDemoPerson[],
  selfCid: string | null,
  max = 4,
): PresenceChips {
  if (people.length < 2) return { chips: [], more: 0 };
  const marked = people.map((person) => ({ ...person, self: person.cid === selfCid }));
  const ordered = [...marked.filter((person) => person.self), ...marked.filter((person) => !person.self)];
  return { chips: ordered.slice(0, max), more: Math.max(0, ordered.length - max) };
}

function channel(value: number): number {
  const unit = value / 255;
  return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return 0;
  const value = parseInt(match[1], 16);
  return 0.2126 * channel((value >> 16) & 255) + 0.7152 * channel((value >> 8) & 255) + 0.0722 * channel(value & 255);
}

/** White or near-black text, whichever reads better on this colour. */
export function readableTextColor(background: string): string {
  const light = luminance(background);
  const withWhite = 1.05 / (light + 0.05);
  const withDark = (light + 0.05) / (luminance("#111111") + 0.05);
  return withDark > withWhite ? "#111111" : "#ffffff";
}

/** A reason is short text from main or the server; keep it to one line's worth. */
function plainReason(reason: string | null | undefined): string {
  return (reason ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
}

/**
 * What the card says about the live connection. Nothing while it works, or while
 * it is first connecting. `joinError` is why the room refused this demo's join
 * (for example, too many viewers), `reason` why the connection is off.
 */
export function liveStatusText(
  status: DesktopLiveDemoStatus | null,
  joinError: string | null,
  reason: string | null = null,
): string {
  const joinText = plainReason(joinError);
  if (joinText) return joinText;
  const why = plainReason(reason);
  if (status === "refused") return why ? `Live view is off. ${why}` : "Live view is not available here.";
  if (status === "offline") return why ? `Live view is off. ${why}` : "Offline. Live view is paused.";
  if (status === "reconnecting") return "Reconnecting…";
  return "";
}
