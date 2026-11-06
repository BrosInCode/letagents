import type { DesktopLiveDemoStatus } from "../../../../../../../electron/ipc-types";
import type { LiveDemoPerson } from "./protocol";

export interface PresenceFaces {
  faces: Array<LiveDemoPerson & { self: boolean; initials: string }>;
  /** People beyond the faces that fit. */
  more: number;
}

/** One or two letters for a face: the first letters of the first two words, or the first two letters. */
export function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const letters = words.length > 1 ? [...words[0]][0] + [...words[1]][0] : [...words[0]].slice(0, 2).join("");
  return letters.toUpperCase();
}

/**
 * The people on a demo, as faces: you first, then the others in the order the
 * server listed them. You show even when alone, so you know the view is live.
 */
export function presenceFaces(
  people: readonly LiveDemoPerson[],
  selfCid: string | null,
  max = 4,
): PresenceFaces {
  const marked = people.map((person) => ({ ...person, self: person.cid === selfCid, initials: initials(person.name) }));
  const ordered = [...marked.filter((person) => person.self), ...marked.filter((person) => !person.self)];
  return { faces: ordered.slice(0, max), more: Math.max(0, ordered.length - max) };
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

export interface LiveStatusLine {
  /** The dot: green while live, amber while it connects again, grey while off. */
  tone: "live" | "waiting" | "off";
  label: string;
  /** What that means for the person, after the label. */
  hint: string;
  /** Pin, Draw and Send work. A mark made while the link is down waits and is saved later. */
  canMark: boolean;
}

/**
 * The line under the demo's name. `joinError` is why the room refused this
 * demo's join (for example, too many viewers), `reason` why the connection is off.
 */
export function liveStatusLine(
  status: DesktopLiveDemoStatus | null,
  joinError: string | null,
  reason: string | null = null,
): LiveStatusLine {
  const joinText = plainReason(joinError);
  if (joinText) return { tone: "off", label: "Not live", hint: joinText, canMark: false };
  const why = plainReason(reason);
  switch (status) {
    case "live":
      return { tone: "live", label: "Live", hint: "People here see your pointer", canMark: true };
    case "reconnecting":
      return { tone: "waiting", label: "Reconnecting…", hint: "Your marks are kept and saved when the link is back", canMark: true };
    case "offline":
      return { tone: "off", label: "Offline", hint: why || "Only you see this demo now", canMark: false };
    case "refused":
      return { tone: "off", label: "Not live", hint: why || "Live view is not available here", canMark: false };
    default:
      return { tone: "waiting", label: "Connecting…", hint: "", canMark: true };
  }
}
