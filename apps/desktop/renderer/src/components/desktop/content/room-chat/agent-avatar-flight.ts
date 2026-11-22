export interface AgentAvatarFlightSource { element: HTMLElement; rect: DOMRect }

export function captureAgentAvatarSource(element: HTMLElement | null): AgentAvatarFlightSource | null {
  if (!element || typeof element.getBoundingClientRect !== "function"
    || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return null;
  const rect = element.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const copy = element.cloneNode(true) as HTMLElement;
  const canvas = element.querySelector("canvas");
  if (canvas && copy.querySelector("canvas")) {
    try {
      const image = document.createElement("img");
      image.src = canvas.toDataURL();
      image.style.cssText = "width:100%;height:100%;object-fit:contain";
      copy.querySelector("canvas")!.replaceWith(image);
    } catch { return null; }
  }
  return { element: copy, rect };
}

/** A presentation-only handoff. It never advances or waits on agent lifecycle state. */
export function flyAgentAvatar(source: AgentAvatarFlightSource | null, destination: HTMLElement | null, hideDestination = false): Animation | undefined {
  if (!source || !destination || typeof document === "undefined"
    || document.hidden || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  const from = source.rect;
  const to = destination.getBoundingClientRect();
  if (!from.width || !from.height || !to.width || !to.height || to.bottom < 0 || to.top > window.innerHeight) return;
  const ghost = source.element.cloneNode(true) as HTMLElement;
  // The visual clone carries no duplicate control, identity or accessibility surface.
  for (const element of [ghost, ...Array.from(ghost.querySelectorAll("[id], [data-testid], [tabindex]"))]) {
    element.removeAttribute("id"); element.removeAttribute("data-testid"); element.removeAttribute("tabindex");
  }
  ghost.setAttribute("aria-hidden", "true");
  ghost.dataset.agentAvatarFlight = "";
  ghost.inert = true;
  Object.assign(ghost.style, {
    position: "fixed", left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px`,
    margin: "0", pointerEvents: "none", zIndex: "10000", transformOrigin: "center", display: "grid", placeItems: "center",
  });
  document.body.appendChild(ghost);
  if (typeof ghost.animate !== "function") { ghost.remove(); return; }
  const dx = to.left + to.width / 2 - from.left - from.width / 2;
  const dy = to.top + to.height / 2 - from.top - from.height / 2;
  const scale = Math.min(to.width / from.width, to.height / from.height);
  const arc = Math.min(130, Math.max(40, Math.abs(dx) * 0.2));
  const flight = ghost.animate([
    { offset: 0, transform: "translate(0, 0) scale(1) rotate(0deg)", opacity: 1 },
    { offset: 0.38, transform: `translate(${dx * 0.4}px, ${dy * 0.4 - arc}px) scale(${Math.max(scale, 0.72)}) rotate(-14deg)`, opacity: 1 },
    { offset: 0.86, transform: `translate(${dx}px, ${dy - 6}px) scale(${scale * 1.1}) rotate(5deg)`, opacity: 1 },
    { offset: 1, transform: `translate(${dx}px, ${dy}px) scale(${scale}) rotate(0deg)`, opacity: hideDestination ? 1 : 0 },
  ], { duration: hideDestination ? 480 : 650, easing: "cubic-bezier(.22,.75,.2,1)", fill: "forwards" });
  const destinationOpacity = destination.style.opacity;
  if (hideDestination) destination.style.opacity = "0";
  const settle = () => {
    if (hideDestination) destination.style.opacity = destinationOpacity;
    ghost.remove();
  };
  void flight.finished.then(settle, settle);
  return flight;
}
