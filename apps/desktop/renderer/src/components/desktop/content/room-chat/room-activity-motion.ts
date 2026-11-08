/**
 * The motion of a command's output opening and closing in the activity strip's list. The list hangs from the
 * pill, so it grows and shrinks at its top edge. Only transform, opacity and clip-path move; the layout changes
 * once, never frame by frame.
 * 1. Opening: the output takes its place at once. Everything above it then slides from where it was to where it
 *    is now, the list's new top edge is revealed by a clip, and the output fades in.
 * 2. Closing: the same motion runs the other way first, and the output leaves the layout at its end, where the
 *    layout is exactly what the motion ended on.
 * A list that scrolls (its content is taller than its limit) changes at once, as does everything when the person
 * asks for reduced motion.
 */

const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";
const OPEN_MS = 200;
const CLOSE_MS = 160;
/** The clip keeps the list's sides and bottom (and their shadow); only its top edge moves. */
const clip = (top: number) => `inset(${Math.max(0, top)}px -48px -48px -48px round 14px)`;

let running: Animation[] = [];

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

function scrolls(list: HTMLElement): boolean {
  return list.scrollHeight > list.clientHeight + 1;
}

/** A motion that still runs ends at once, so a new one starts from a settled layout. */
function settle(): void {
  const current = running;
  running = [];
  for (const animation of current) animation.finish();
}

/** What sits above a command's output: the rows before the command, and the command's own row. */
function movingParts(list: HTMLElement, command: HTMLElement): HTMLElement[] {
  const parts: HTMLElement[] = [];
  for (const child of Array.from(list.children) as HTMLElement[]) {
    if (child !== command) {
      parts.push(child);
      continue;
    }
    parts.push(...(Array.from(command.children) as HTMLElement[]).filter((part) => !part.classList.contains("room-activity-terminal-wrap")));
    break;
  }
  return parts;
}

/** Open a command's output: `apply` puts it in the layout (and resolves once the DOM shows it). */
export async function openCommandOutput(list: HTMLElement | null, command: HTMLElement | null, apply: () => Promise<void>): Promise<void> {
  settle();
  if (!list || !command || reducedMotion() || typeof list.animate !== "function") {
    await apply();
    return;
  }
  const before = list.getBoundingClientRect().top;
  await apply();
  const delta = before - list.getBoundingClientRect().top;
  const output = command.querySelector<HTMLElement>(".room-activity-terminal-wrap");
  if (delta <= 0 || scrolls(list) || !output) return;
  const timing: KeyframeAnimationOptions = { duration: OPEN_MS, easing: EASE_OUT };
  running = [
    list.animate([{ clipPath: clip(delta) }, { clipPath: clip(0) }], timing),
    ...movingParts(list, command).map((part) => part.animate([{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }], timing)),
    output.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, delay: 40, easing: "ease-out", fill: "backwards" }),
  ];
}

/** Close a command's output: the motion runs first, then `apply` takes it out of the layout. */
export async function closeCommandOutput(list: HTMLElement | null, command: HTMLElement | null, apply: () => Promise<void>): Promise<void> {
  settle();
  const output = command?.querySelector<HTMLElement>(".room-activity-terminal-wrap") ?? null;
  const delta = output?.getBoundingClientRect().height ?? 0;
  if (!list || !command || !output || delta <= 0 || reducedMotion() || scrolls(list) || typeof list.animate !== "function") {
    await apply();
    return;
  }
  const timing: KeyframeAnimationOptions = { duration: CLOSE_MS, easing: EASE_OUT, fill: "forwards" };
  const motion = [
    list.animate([{ clipPath: clip(0) }, { clipPath: clip(delta) }], timing),
    ...movingParts(list, command).map((part) => part.animate([{ transform: "translateY(0)" }, { transform: `translateY(${delta}px)` }], timing)),
    output.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 110, easing: "ease-out", fill: "forwards" }),
  ];
  running = motion;
  // A hidden window can hold animation time still: the output closes on time whatever the motion does.
  await Promise.race([
    Promise.all(motion.map((animation) => animation.finished.catch(() => undefined))),
    new Promise((resolve) => setTimeout(resolve, CLOSE_MS + 80)),
  ]);
  await apply();
  // The layout now is where the motion ended: the held end frames go in the same frame.
  for (const animation of motion) animation.cancel();
  if (running === motion) running = [];
}
