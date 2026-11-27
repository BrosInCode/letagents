/**
 * The welcome screen becomes the next screen instead of cutting to it: each piece travels
 * to its counterpart and blends into it. The next screen marks its pieces with
 * `data-morph="heading" | "brand" | "primary" | "rise"`.
 *
 * Only transforms, opacity and a short blur are animated (compositor work). Every animation
 * is cancelled at the end, so the incoming elements fall back to their own styles.
 */
export interface MorphInput {
  from: HTMLElement;
  to: HTMLElement;
  reduced: boolean;
  heading: HTMLElement | null;
  subline: HTMLElement | null;
  button: HTMLElement | null;
  canvas: HTMLCanvasElement | null;
  /** Where the ink mark is on the canvas (uv, y up) and its height as a part of the canvas. */
  markCenter: [number, number];
  markHeight: number;
}

const EASE = "cubic-bezier(.65, 0, .35, 1)";

export async function morphInto(input: MorphInput): Promise<void> {
  const { from, to, reduced } = input;
  const q = <T extends Element = HTMLElement>(selector: string) => to.querySelector(selector) as T | null;
  const travel = reduced ? 1 : 780;
  const animations: Animation[] = [];
  const play = (el: Element | null, frames: Keyframe[], options: KeyframeAnimationOptions) => {
    if (el) animations.push(el.animate(frames, { fill: "both", easing: EASE, ...options }));
  };
  const rect = (el: Element) => el.getBoundingClientRect();

  // The page behind lets go first.
  play(from, [{ backgroundColor: "#0a0b0a" }, { backgroundColor: "rgba(10, 11, 10, 0)" }], { duration: 380 });
  play(from.querySelector(".welcome-grain"), [{ opacity: .045 }, { opacity: 0 }], { duration: 380 });
  play(input.subline, [{ opacity: 1 }, { opacity: 0, transform: "translateY(6px)" }], { duration: 260, easing: "ease-out" });
  play(from.querySelector(".auth-hint"), [{ opacity: 1 }, { opacity: 0 }], { duration: 200 });

  // Headline → heading: move and resize, blending through a soft blur.
  const fromHeading = input.heading, toHeading = q('[data-morph="heading"]');
  if (fromHeading && toHeading) {
    const a = rect(fromHeading), b = rect(toHeading);
    const ratio = parseFloat(getComputedStyle(toHeading).fontSize) / parseFloat(getComputedStyle(fromHeading).fontSize) || 1;
    fromHeading.style.transformOrigin = toHeading.style.transformOrigin = "0 0";
    play(fromHeading, [
      { transform: "none", opacity: 1, filter: "blur(0)" },
      { transform: `translate(${b.left - a.left}px, ${b.top - a.top}px) scale(${ratio})`, opacity: 0, filter: "blur(6px)" },
    ], { duration: travel });
    play(toHeading, [
      { transform: `translate(${a.left - b.left}px, ${a.top - b.top}px) scale(${1 / ratio})`, opacity: 0, filter: "blur(6px)" },
      { transform: "none", opacity: 1, filter: "blur(0)" },
    ], { duration: travel, delay: 60 });
  }

  // The ink mark flies up into the logo.
  const canvas = input.canvas, brand = q('[data-morph="brand"]'), logo = brand?.querySelector("svg") ?? null;
  if (canvas && logo) {
    const c = rect(canvas), t = rect(logo);
    const cx = c.width * input.markCenter[0], cy = c.height * (1 - input.markCenter[1]), size = c.height * input.markHeight;
    const scale = t.height / size;
    const dx = t.left + t.width / 2 - (c.left + cx), dy = t.top + t.height / 2 - (c.top + cy);
    canvas.style.transformOrigin = `${cx}px ${cy}px`;
    play(canvas, [
      { transform: "none", opacity: 1 },
      { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: 1, offset: .82 },
      { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: 0 },
    ], { duration: travel + 140 });
    play(brand, [{ opacity: 0 }, { opacity: 0, offset: .7 }, { opacity: 1 }], { duration: travel + 140, easing: "ease-out" });
  }

  // The signed-in pill stretches into the next screen's main button.
  const fromPill = input.button, toButton = q('[data-morph="primary"]');
  if (fromPill && toButton) {
    const a = rect(fromPill), b = rect(toButton);
    const dx = b.left + b.width / 2 - (a.left + a.width / 2), dy = b.top + b.height / 2 - (a.top + a.height / 2);
    play(fromPill, [
      { transform: "none", opacity: 1 },
      { transform: `translate(${dx}px, ${dy}px) scale(${b.width / a.width}, ${b.height / a.height})`, opacity: 0 },
    ], { duration: travel });
    play(toButton, [
      { transform: `translate(${-dx}px, ${-dy}px) scale(${a.width / b.width}, ${a.height / b.height})`, opacity: 0 },
      { opacity: .2, offset: .45 },
      { transform: "none", opacity: 1 },
    ], { duration: travel });
  }

  // Everything else on the next screen rises in, one after another.
  const rest = [...to.querySelectorAll('[data-morph="rise"]')];
  rest.forEach((el, i) => play(el, [{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }],
    { duration: reduced ? 1 : 460, delay: reduced ? 0 : 360 + i * 55, easing: "cubic-bezier(.23, 1, .32, 1)" }));

  await Promise.all(animations.map(animation => animation.finished.catch(() => undefined)));
  // Hand the incoming elements back to their own styles.
  [toHeading, brand, toButton, ...rest].forEach(el => el?.getAnimations().forEach(animation => animation.cancel()));
}
