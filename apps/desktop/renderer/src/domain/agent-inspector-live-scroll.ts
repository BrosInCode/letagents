/** Follow the Live transcript until the reader takes control of its viewport. */
export function followAgentLiveScroll(viewport: HTMLElement, content: HTMLElement): () => void {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let following = true;
  let frame: number | null = null;
  let previousTime = 0;
  let interactionInLive = false;
  let inspectingDetails = false;
  const previousAnchor = viewport.style.overflowAnchor;
  viewport.style.overflowAnchor = "none";
  viewport.scrollTop = viewport.scrollHeight;
  let lastTop = viewport.scrollTop;
  let animatedTop = lastTop;

  function pause(): void {
    following = false;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  }

  function step(time: number): void {
    frame = null;
    const target = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const distance = target - animatedTop;
    // Retarget the running animation as text grows, without restarting its easing.
    const elapsed = Math.min(64, Math.max(1, time - previousTime));
    previousTime = time;
    animatedTop = reducedMotion.matches || Math.abs(distance) < 1
      ? target
      : animatedTop + distance * (1 - Math.exp(-elapsed / 60));
    // Keep fractional progress even when the browser rounds scrollTop to pixels.
    viewport.scrollTop = animatedTop;
    lastTop = viewport.scrollTop;
    if (animatedTop !== target) frame = requestAnimationFrame(step);
  }

  function follow(): void {
    if (!following || frame !== null) return;
    animatedTop = viewport.scrollTop;
    previousTime = performance.now();
    frame = requestAnimationFrame(step);
  }

  function onScroll(): void {
    const top = viewport.scrollTop;
    if (top < lastTop - 1) pause();
    else if (frame === null && top > lastTop) {
      following = viewport.scrollHeight - viewport.clientHeight - top <= 24;
      follow();
    }
    lastTop = top;
  }

  function onWheel(event: WheelEvent): void {
    if (event.deltaY < 0) pause();
  }

  function onKey(event: KeyboardEvent): void {
    if (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)) pause();
  }

  function onInteractionStart(event: Event): void {
    interactionInLive = true;
    inspectingDetails = event.target instanceof Element && !!event.target.closest("details");
    pause();
  }

  function onInteractionEnd(): void {
    if (!interactionInLive) return;
    interactionInLive = false;
    if (inspectingDetails) return;
    if (window.getSelection()?.isCollapsed === false) return;
    if (viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 1) {
      following = true;
      follow();
    }
  }

  // Pointer/touch interaction also protects text selection and expanded tool details.
  viewport.addEventListener("scroll", onScroll, { passive: true });
  viewport.addEventListener("wheel", onWheel, { passive: true });
  viewport.addEventListener("pointerdown", onInteractionStart);
  viewport.addEventListener("touchstart", onInteractionStart, { passive: true });
  viewport.addEventListener("keydown", onKey);
  window.addEventListener("pointerup", onInteractionEnd);
  window.addEventListener("touchend", onInteractionEnd, { passive: true });
  const observer = new ResizeObserver(follow);
  observer.observe(content);
  observer.observe(viewport);

  return () => {
    pause();
    observer.disconnect();
    viewport.style.overflowAnchor = previousAnchor;
    viewport.removeEventListener("scroll", onScroll);
    viewport.removeEventListener("wheel", onWheel);
    viewport.removeEventListener("pointerdown", onInteractionStart);
    viewport.removeEventListener("touchstart", onInteractionStart);
    viewport.removeEventListener("keydown", onKey);
    window.removeEventListener("pointerup", onInteractionEnd);
    window.removeEventListener("touchend", onInteractionEnd);
  };
}
