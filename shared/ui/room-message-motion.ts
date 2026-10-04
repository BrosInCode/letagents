/** Geometry and WAAPI effects shared by the real desktop and web timelines. */
export interface MessageMotionIdentity { session?: string | null; key?: string | null }
export interface MotionMessage extends MessageMotionIdentity {
  id: string; stableId: string; text: string; outgoing?: boolean;
}
export function sameMotionAgent(a: MessageMotionIdentity, b: MessageMotionIdentity): boolean {
  if (a.session && b.session) return a.session === b.session;
  return Boolean(a.key && b.key && a.key.trim().toLowerCase() === b.key.trim().toLowerCase());
}
export function appendedMotionMessages(previous: readonly string[], messages: readonly MotionMessage[]): MotionMessage[] {
  if (!previous.length) return [];
  const last = messages.findIndex(message => message.stableId === previous.at(-1));
  if (last < 0) return [];
  const seen = new Set(previous);
  return messages.slice(last + 1).filter(message => !seen.has(message.stableId));
}
const bubbleSelector = '.room-message-bubble, .message-bubble';
const metaSelector = '.room-message-meta, .message-meta';
const avatarSelector = '.room-chat-avatar, .message-avatar';
const ease = 'cubic-bezier(.22,1,.36,1)';
export interface WorkGeometry {
  bounds: DOMRect; pulse: DOMRect; name: DOMRect; summary: DOMRect;
  clone: HTMLElement; dots: Keyframe[];
}
export function captureWork(element: HTMLElement): WorkGeometry | null {
  const pulse = element.querySelector<HTMLElement>('.room-local-agent-work-pulse');
  const name = element.querySelector<HTMLElement>('strong');
  const summary = element.querySelector<HTMLElement>('.room-local-agent-work-copy > span');
  if (!pulse || !name || !summary) return null;
  return {
    bounds: element.getBoundingClientRect(), pulse: pulse.getBoundingClientRect(),
    name: name.getBoundingClientRect(), summary: summary.getBoundingClientRect(),
    clone: element.cloneNode(true) as HTMLElement,
    dots: [...element.querySelectorAll('i')].map(dot => {
      const style = getComputedStyle(dot); return { opacity: style.opacity, transform: style.transform };
    }),
  };
}
export function createRoomMessageAnimator(viewport: () => HTMLElement | null) {
  const animations = new Set<Animation>();
  const cleanups = new Set<() => void>();
  function animate(element: Element | null, frames: Keyframe[], options: KeyframeAnimationOptions) {
    if (!element || typeof element.animate !== 'function') return null;
    const animation = element.animate(frames, options);
    animations.add(animation);
    animation.finished.then(() => animations.delete(animation), () => animations.delete(animation));
    return animation;
  }
  function cancel() {
    animations.forEach(animation => animation.cancel()); animations.clear();
    cleanups.forEach(cleanup => cleanup()); cleanups.clear();
  }
  function layer() {
    const element = document.createElement('div');
    element.className = 'room-message-motion-layer';
    element.setAttribute('aria-hidden', 'true'); element.inert = true;
    Object.assign(element.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '50', overflow: 'hidden' });
    document.body.append(element);
    const cleanup = () => { element.remove(); cleanups.delete(cleanup); };
    cleanups.add(cleanup);
    return { element, cleanup };
  }
  function reveal(row: HTMLElement) {
    animate(row, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: ease });
  }
  function move(positions: Map<HTMLElement, DOMRect>) {
    positions.forEach((before, element) => {
      if (!element.isConnected) return;
      const delta = before.top - element.getBoundingClientRect().top;
      if (Math.abs(delta) > 1) animate(element, [{ transform: `translateY(${delta}px)` }, { transform: 'none' }], { duration: 260, easing: ease });
    });
  }
  function send(row: HTMLElement, source: DOMRect, keyboard: boolean) {
    const bubble = row.querySelector<HTMLElement>(bubbleSelector), stream = viewport();
    if (!bubble || !stream) return;
    const target = bubble.getBoundingClientRect();
    if (target.height > stream.clientHeight * .65) { reveal(row); return; }
    const duration = keyboard ? 280 : 360;
    const overlay = layer();
    const clone = bubble.cloneNode(true) as HTMLElement;
    // Copy inherited typography/tokens too: the flight lives outside the room's theme scope.
    const style = getComputedStyle(bubble);
    for (const property of style) clone.style.setProperty(property, style.getPropertyValue(property));
    clone.removeAttribute('id'); clone.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
    Object.assign(clone.style, { position: 'absolute', left: `${target.left}px`, top: `${target.top}px`, width: `${target.width}px`, height: `${target.height}px`, maxWidth: 'none', margin: '0', transformOrigin: '0 0', pointerEvents: 'none' });
    overlay.element.append(clone);
    const opacity = bubble.style.opacity; bubble.style.opacity = '0';
    const restore = () => { bubble.style.opacity = opacity; overlay.cleanup(); cleanups.delete(restore); };
    cleanups.add(restore);
    const dx = source.left - target.left - parseFloat(style.paddingLeft);
    const dy = source.top - target.top - parseFloat(style.paddingTop);
    const flight = animate(clone, [
      { transform: `translate(${dx}px,${dy}px) scale(.98)`, opacity: .8, easing: ease },
      { transform: 'none', opacity: 1 },
    ], { duration });
    if (flight) flight.finished.then(restore, restore); else restore();
    for (const selector of [metaSelector, avatarSelector]) animate(row.querySelector(selector), [
      { opacity: 0, transform: 'translateY(5px)' }, { opacity: 1, transform: 'none' },
    ], { duration: duration * .45, delay: duration * .35, fill: 'backwards', easing: ease });
  }
  function reply(row: HTMLElement, source: WorkGeometry) {
    const bubble = row.querySelector<HTMLElement>(bubbleSelector), stream = viewport();
    if (!bubble || !stream) return;
    const target = bubble.getBoundingClientRect(), bounds = stream.getBoundingClientRect();
    if (source.bounds.bottom < bounds.top || source.bounds.top > bounds.bottom || target.height > bounds.height * .8) { reveal(row); return; }
    const duration = 440, style = getComputedStyle(bubble);
    const overlay = layer();
    Object.assign(overlay.element.style, { inset: 'auto', left: `${bounds.left}px`, top: `${bounds.top}px`, width: `${bounds.width}px`, height: `${bounds.height}px` });
    const shell = document.createElement('div');
    Object.assign(shell.style, { position: 'absolute', boxSizing: 'border-box', background: style.background, border: style.border, borderRadius: style.borderRadius, boxShadow: style.boxShadow });
    const ghost = source.clone;
    Object.assign(ghost.style, { position: 'absolute', left: `${source.bounds.left - bounds.left}px`, top: `${source.bounds.top - bounds.top}px`, width: `${source.bounds.width}px`, height: `${source.bounds.height}px`, margin: '0' });
    ghost.querySelectorAll<HTMLElement>('.room-local-agent-work-pulse, strong').forEach(element => { element.style.visibility = 'hidden'; });
    overlay.element.append(shell, ghost);
    const seed = source.summary;
    Object.assign(shell.style, { left: `${target.left - bounds.left}px`, top: `${target.top - bounds.top}px`, width: `${target.width}px`, height: `${target.height}px`, transformOrigin: '0 0' });
    const start = `translate(${seed.left - target.left - 9}px,${seed.top - target.top - 5}px) scale(${(source.bounds.right - seed.left + 9) / target.width},${(seed.height + 10) / target.height})`;
    const surface = animate(shell, [{ transform: start, opacity: .8, easing: ease }, { transform: 'none', opacity: 1, offset: .7 }, { transform: 'none', opacity: 0 }], { duration });
    surface?.finished.then(overlay.cleanup, overlay.cleanup);
    for (const [selector, before] of [[avatarSelector, source.pulse], [`${metaSelector.split(',')[0]} strong, .room-message-author-button, .message-sender strong`, source.name]] as const) {
      const element = row.querySelector(selector);
      if (!element) continue;
      const after = element.getBoundingClientRect();
      animate(element, [{ transform: `translate(${before.left - after.left}px,${before.top - after.top}px)` }, { transform: 'none' }], { duration: duration * .7, easing: ease });
    }
    animate(ghost.querySelector('.room-local-agent-work-copy > span'), [{ opacity: 1 }, { opacity: 0, transform: 'translateX(-8px)' }], { duration: duration * .28, easing: ease, fill: 'forwards' });
    ghost.querySelectorAll<HTMLElement>('i').forEach((dot, index) => {
      dot.style.animation = 'none';
      animate(dot, [source.dots[index] || { opacity: 1 }, { opacity: 1, transform: `translateX(${-index * 6}px) scale(1.3)`, offset: .6 }, { opacity: 0, transform: `translateX(${-index * 6}px) scale(.8)` }], { duration: duration * .38, easing: ease, fill: 'forwards' });
    });
    animate(bubble, [{ opacity: 0 }, { opacity: 0, offset: .2 }, { opacity: 1 }], { duration });
    animate(bubble.querySelector('.desktop-long-message, .long-message-content, .md-content') || bubble.firstElementChild,
      [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }],
      { duration: duration * .5, delay: duration * .2, fill: 'backwards', easing: ease });
  }
  return { cancel, move, send, reply, reveal };
}
