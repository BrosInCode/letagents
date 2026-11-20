const reducedMotion = "(prefers-reduced-motion: reduce)";
const landingWait = 2_500;
const maxLandingWait = 5_000;
const departureDuration = 420;
const landingDuration = 460;

type ActiveEntry = () => string | null;
type Landing = { icon: SVGSVGElement; bounds: DOMRect };

function roomLanding(entryId: string, reveal = false): Landing | undefined {
  const shell = document.querySelector(".desktop-shell");
  const row = shell?.querySelector<HTMLElement>(
    `[data-sidebar-entry-id="${CSS.escape(entryId)}"][data-active="true"]`,
  );
  const icon = shell?.getAttribute("data-sidebar-mode") === "hidden"
    ? shell.querySelector<SVGSVGElement>(".desktop-room-sidebar-reveal svg")
    : row?.querySelector<SVGSVGElement>(":is(.pin-mark, .project-icon) svg");
  if (!icon?.checkVisibility({ visibilityProperty: true })
    || !icon.parentElement?.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return;
  let bounds = icon.getBoundingClientRect();
  const viewport = icon.closest(".sidebar-room-sections")?.getBoundingClientRect();
  if (viewport && (bounds.bottom > viewport.bottom || bounds.top < viewport.top)) {
    if (!reveal) return;
    row?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    bounds = icon.getBoundingClientRect();
    if (bounds.bottom > viewport.bottom || bounds.top < viewport.top) return;
  }
  return bounds.width && bounds.height ? { icon, bounds } : undefined;
}

function sameLanding(a: Landing | undefined, b: Landing): boolean {
  return Boolean(a && a.icon === b.icon && (["left", "top", "width", "height"] as const)
    .every(side => Math.abs(a.bounds[side] - b.bounds[side]) < .5));
}

function waitForLanding(activeEntry: ActiveEntry, preference: MediaQueryList, metadataReady: Promise<void>): Promise<Landing | undefined> {
  return new Promise(resolve => {
    let previous: Landing | undefined;
    let frame = 0;
    let deadline = 0;
    let finished = false;
    const finish = (landing?: Landing) => {
      finished = true;
      clearTimeout(deadline);
      clearTimeout(fallback);
      cancelAnimationFrame(frame);
      resolve(landing);
    };
    const fallback = window.setTimeout(finish, maxLandingWait);
    const startGracePeriod = () => {
      if (!finished) deadline = window.setTimeout(finish, landingWait);
    };
    void metadataReady.then(startGracePeriod, startGracePeriod);
    const check = () => {
      const entryId = activeEntry();
      if (!entryId || preference.matches) { finish(); return; }
      const landing = roomLanding(entryId, true);
      if (landing && sameLanding(previous, landing)) { finish(landing); return; }
      previous = landing;
      frame = requestAnimationFrame(check);
    };
    frame = requestAnimationFrame(check);
  });
}

export function prepareFirstRoomFlight(icon: HTMLElement | undefined, onStart: () => void) {
  if (!icon || window.matchMedia(reducedMotion).matches) return;
  const glyph = icon.querySelector("svg");
  const origin = icon.getBoundingClientRect();
  if (!glyph || !origin.width || !origin.height) return;
  const style = getComputedStyle(icon);
  const accent = style.getPropertyValue("--workspace-accent").trim()
    || style.getPropertyValue("--setup-accent").trim()
    || style.color;
  const flight = document.createElement("span");
  flight.className = "first-room-flight";
  flight.setAttribute("aria-hidden", "true");
  Object.assign(flight.style, {
    left: `${origin.left}px`, top: `${origin.top}px`,
    width: `${origin.width}px`, height: `${origin.height}px`,
    color: style.getPropertyValue("--setup-text").trim() || style.color,
  });
  flight.style.setProperty("--first-room-accent", accent);
  flight.style.setProperty("--first-room-duration", `${landingDuration}ms`);
  flight.append(glyph.cloneNode(true));
  document.body.append(flight);
  icon.dataset.firstRoomDeparture = "";

  // Start with motion toward the sidebar. The real row owns the end position
  // once the room snapshot and workspace are available.
  const approachX = Math.min(72, origin.left) - origin.left;
  const approachY = -Math.min(48, origin.top * .14);
  const departure = flight.animate([
    { transform: "translate3d(0, 0, 0)" },
    { transform: `translate3d(${approachX}px, ${approachY}px, 0)` },
  ], { duration: departureDuration, easing: "cubic-bezier(.23, .66, .34, 1)", fill: "forwards" });

  const fly = async (activeEntry: ActiveEntry, metadataReady: Promise<void>) => {
    const preference = window.matchMedia(reducedMotion);
    const initialLanding = await waitForLanding(activeEntry, preference, metadataReady);
    if (!initialLanding) return;
    let landing = initialLanding;
    const approachTransform = getComputedStyle(flight).transform;
    departure.cancel();
    const destinationGlyph = landing.icon.cloneNode(true) as SVGSVGElement;
    destinationGlyph.style.color = getComputedStyle(landing.icon).color;
    flight.append(destinationGlyph);
    flight.dataset.landing = "";
    landing.icon.dataset.firstRoomLanding = "";

    function landingFrame(target: Landing): Keyframe {
      const { left, top, width, height } = target.bounds;
      const x = left - origin.left;
      const y = top - origin.top;
      const scale = `${width / origin.width}, ${height / origin.height}`;
      return { transform: `translate3d(${x}px, ${y}px, 0) scale(${scale})` };
    }

    const animation = flight.animate([
      { transform: approachTransform },
      landingFrame(landing),
    ], { duration: landingDuration, easing: "cubic-bezier(.32, .04, .43, 1)", fill: "both" });
    let frame = 0;
    const cancel = () => animation.cancel();
    // Data can replace or move the sidebar row after the workspace appears.
    // Pause for a missing row and retarget from the current position when it returns.
    function followSidebar() {
      const entryId = activeEntry();
      if (!entryId || preference.matches) { cancel(); return; }
      const next = roomLanding(entryId);
      if (!next) {
        if (animation.playState === "running") animation.pause();
      } else {
        if (!sameLanding(landing, next)) {
          const effect = animation.effect as KeyframeEffect;
          const elapsed = typeof animation.currentTime === "number" ? animation.currentTime : 0;
          const from = { transform: getComputedStyle(flight).transform };
          delete landing.icon.dataset.firstRoomLanding;
          next.icon.dataset.firstRoomLanding = "";
          destinationGlyph.style.color = getComputedStyle(next.icon).color;
          effect.setKeyframes([from, landingFrame(next)]);
          effect.updateTiming({ duration: Math.max(120, Number(effect.getTiming().duration) - elapsed) });
          animation.currentTime = 0;
          landing = next;
        }
        if (animation.playState === "paused") animation.play();
      }
      frame = requestAnimationFrame(followSidebar);
    }
    frame = requestAnimationFrame(followSidebar);
    const deadline = window.setTimeout(cancel, landingWait);
    preference.addEventListener("change", cancel);
    onStart();
    try {
      await animation.finished;
    } catch { /* Cancellation leaves the real room available. */ }
    finally {
      clearTimeout(deadline);
      cancelAnimationFrame(frame);
      preference.removeEventListener("change", cancel);
      delete landing.icon.dataset.firstRoomLanding;
    }
  };

  return {
    fly,
    dispose: () => {
      departure.cancel();
      delete icon.dataset.firstRoomDeparture;
      flight.remove();
    },
  };
}
