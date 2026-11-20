const reducedMotion = "(prefers-reduced-motion: reduce)";
const landingWait = 2_500;
const maxLandingWait = 5_000;
const flightDuration = 420;

type ActiveEntry = () => string | null;
type Landing = { icon: SVGSVGElement; bounds: DOMRect };

function roomLanding(entryId: string, reveal = false): Landing | undefined {
  const shell = document.querySelector(".desktop-shell");
  const row = shell?.querySelector<HTMLElement>(
    `[data-sidebar-entry-id="${CSS.escape(entryId)}"][data-active="true"]`,
  );
  if (shell?.getAttribute("data-sidebar-mode") === "hidden") return;
  const icon = row?.querySelector<SVGSVGElement>(":is(.pin-mark, .project-icon) svg");
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
    let ready = false;
    const finish = (landing?: Landing) => {
      finished = true;
      clearTimeout(deadline);
      clearTimeout(fallback);
      cancelAnimationFrame(frame);
      resolve(landing);
    };
    const fallback = window.setTimeout(finish, maxLandingWait);
    const startGracePeriod = () => {
      ready = true;
      if (!finished) deadline = window.setTimeout(finish, landingWait);
    };
    void metadataReady.then(startGracePeriod, startGracePeriod);
    const check = () => {
      const entryId = activeEntry();
      if (!entryId || preference.matches || document.querySelector('.desktop-shell[data-sidebar-mode="hidden"]')) { finish(); return; }
      const landing = ready ? roomLanding(entryId, true) : undefined;
      if (landing && sameLanding(previous, landing)) { finish(landing); return; }
      previous = landing;
      frame = requestAnimationFrame(check);
    };
    frame = requestAnimationFrame(check);
  });
}

export function prepareFirstRoomFlight(icon: HTMLElement | undefined, onStart: (sidebarEdge: number) => void) {
  const preference = window.matchMedia(reducedMotion);
  const glyph = icon?.querySelector("svg");
  if (!icon || !glyph || preference.matches) return;
  icon.dataset.firstRoomDeparture = "";

  async function fly(activeEntry: ActiveEntry, metadataReady: Promise<void>) {
    const landing = await waitForLanding(activeEntry, preference, metadataReady);
    if (!landing || !glyph?.isConnected) return;
    const origin = glyph.getBoundingClientRect();
    const sidebar = landing.icon.closest(".desktop-sidebar-frame")?.getBoundingClientRect();
    if (!origin.width || !origin.height || !sidebar) return;
    const flight = document.createElement("span");
    flight.className = "first-room-flight";
    flight.setAttribute("aria-hidden", "true");
    Object.assign(flight.style, {
      left: `${origin.left}px`, top: `${origin.top}px`,
      width: `${origin.width}px`, height: `${origin.height}px`,
      color: getComputedStyle(glyph).color,
    });
    flight.append(glyph.cloneNode(true));
    document.body.append(flight);
    landing.icon.dataset.firstRoomLanding = "";
    const { left, top, width, height } = landing.bounds;
    const animation = flight.animate([
      { transform: "translate3d(0, 0, 0) scale(1, 1)" },
      { transform: `translate3d(${left - origin.left}px, ${top - origin.top}px, 0) scale(${width / origin.width}, ${height / origin.height})` },
    ], { duration: flightDuration, easing: "cubic-bezier(.4, 0, .25, 1)", fill: "both" });
    let frame = 0;
    const cancel = () => animation.cancel();
    function checkTarget() {
      const entry = activeEntry();
      const current = entry && roomLanding(entry);
      if (!current || !sameLanding(landing, current)) { cancel(); return; }
      frame = requestAnimationFrame(checkTarget);
    }
    frame = requestAnimationFrame(checkTarget);
    preference.addEventListener("change", cancel);
    onStart(sidebar.right);
    try {
      await animation.finished;
    } catch { /* A changed destination ends the handoff in the actual workspace. */ }
    finally {
      cancelAnimationFrame(frame);
      preference.removeEventListener("change", cancel);
      delete landing.icon.dataset.firstRoomLanding;
      flight.remove();
    }
  }

  return { fly, dispose: () => { delete icon.dataset.firstRoomDeparture; } };
}
