const reducedMotion = "(prefers-reduced-motion: reduce)";

export function prepareFirstRoomFlight(icon?: HTMLElement): ((entryId: string) => Promise<void>) | undefined {
  if (!icon || window.matchMedia(reducedMotion).matches) return;
  const glyph = icon.querySelector("svg");
  const origin = icon.getBoundingClientRect();
  if (!glyph || !origin.width || !origin.height) return;
  const copy = glyph.cloneNode(true);
  const style = getComputedStyle(icon);
  const color = style.getPropertyValue("--workspace-accent").trim() || style.color;

  return async entryId => {
    const preference = window.matchMedia(reducedMotion);
    if (preference.matches) return;
    const row = document.querySelector<HTMLElement>(
      `[data-sidebar-entry-id="${CSS.escape(entryId)}"][data-active="true"]`,
    );
    const sidebarIcon = row?.querySelector<HTMLElement>(":is(.pin-mark, .project-icon)");
    if (sidebarIcon?.getClientRects().length) {
      row?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    }
    const target = (sidebarIcon?.getClientRects().length ? sidebarIcon
      : document.querySelector(".desktop-room-sidebar-reveal"))?.querySelector("svg");
    const destination = target?.getBoundingClientRect();
    if (!target || !destination?.width || !destination.height) return;

    const flight = document.createElement("span");
    flight.className = "first-room-flight";
    flight.setAttribute("aria-hidden", "true");
    Object.assign(flight.style, {
      left: `${origin.left}px`, top: `${origin.top}px`,
      width: `${origin.width}px`, height: `${origin.height}px`, color,
    });
    flight.append(copy, target.cloneNode(true));
    document.body.append(flight);
    target.dataset.firstRoomLanding = "";
    const animation = flight.animate([
      { transform: "translate3d(0, 0, 0) scale(1)", color },
      { transform: `translate3d(${destination.left - origin.left}px, ${destination.top - origin.top}px, 0) scale(${destination.width / origin.width}, ${destination.height / origin.height})`, color: getComputedStyle(target).color },
    ], { duration: 600, easing: "cubic-bezier(.52, .07, .14, 1)", fill: "both" });
    const cancel = () => animation.cancel();
    window.addEventListener("resize", cancel);
    window.addEventListener("pointerdown", cancel);
    preference.addEventListener("change", cancel);
    try {
      await animation.finished;
    } catch { /* The real sidebar icon takes over if the window or motion preference changes. */ }
    finally {
      window.removeEventListener("resize", cancel);
      window.removeEventListener("pointerdown", cancel);
      preference.removeEventListener("change", cancel);
      delete target.dataset.firstRoomLanding;
      flight.remove();
    }
  };
}
