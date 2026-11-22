const reducedMotion = "(prefers-reduced-motion: reduce)";
const maxLandingWait = 5_000;
const flightDuration = 420;

type ActiveEntry = () => string | null;
type Landing = { entryId: string; icon: SVGSVGElement; bounds: DOMRect };

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
  return bounds.width && bounds.height ? { entryId, icon, bounds } : undefined;
}

function sameLanding(a: Landing | undefined, b: Landing): boolean {
  return Boolean(a && a.entryId === b.entryId && (["left", "top", "width", "height"] as const)
    .every(side => Math.abs(a.bounds[side] - b.bounds[side]) < .5));
}

function waitForLanding(activeEntry: ActiveEntry, preference: MediaQueryList): Promise<Landing | undefined> {
  return new Promise(resolve => {
    let previous: Landing | undefined;
    let frame = 0;
    const finish = (landing?: Landing) => {
      clearTimeout(fallback);
      cancelAnimationFrame(frame);
      resolve(landing);
    };
    const fallback = window.setTimeout(finish, maxLandingWait);
    const check = () => {
      const entryId = activeEntry();
      if (!entryId || preference.matches || document.querySelector('.desktop-shell[data-sidebar-mode="hidden"]')) { finish(); return; }
      const landing = roomLanding(entryId, true);
      if (landing && sameLanding(previous, landing)) { finish(landing); return; }
      previous = landing;
      frame = requestAnimationFrame(check);
    };
    frame = requestAnimationFrame(check);
  });
}

export function prepareFirstRoomFlight(icon: HTMLElement | undefined, onStart: (sidebarEdge: number) => void) {
  const preference = window.matchMedia(reducedMotion);
  const roomId = icon?.closest<HTMLElement>("[data-room-id]")?.dataset.roomId;
  if (!icon || !roomId || preference.matches) return;
  const sourceRow = `.company-rooms-row[data-room-id="${CSS.escape(roomId)}"]`;
  icon.dataset.firstRoomDeparture = "";

  async function fly(activeEntry: ActiveEntry) {
    const landing = await waitForLanding(activeEntry, preference);
    const source = document.querySelector<HTMLElement>(`${sourceRow} .company-rooms-icon`);
    const glyph = source?.querySelector("svg");
    if (!landing || !source || !glyph?.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return;
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
    source.dataset.firstRoomDeparture = "";
    let landingIcon = landing.icon;
    landingIcon.dataset.firstRoomLanding = "";
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
      if (current.icon !== landingIcon) {
        delete landingIcon.dataset.firstRoomLanding;
        landingIcon = current.icon;
        landingIcon.dataset.firstRoomLanding = "";
      }
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
      delete landingIcon.dataset.firstRoomLanding;
      delete source.dataset.firstRoomDeparture;
      flight.remove();
    }
  }

  return { fly, dispose: () => { delete icon.dataset.firstRoomDeparture; } };
}
