/** Morph the invoking room affordance into the inspector without scaling its text. */
export function animateInspectorOpening(panel: HTMLElement, trigger: HTMLElement | null, done: () => void): () => void {
  if (typeof panel.animate !== 'function') { done(); return () => {}; }
  const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (preference.matches) { done(); return () => {}; }
  const animations: Animation[] = [];
  const artifacts: HTMLElement[] = [];
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    animations.forEach(animation => animation.cancel());
    artifacts.forEach(element => element.remove());
    preference.removeEventListener('change', finish);
    window.removeEventListener('resize', finish);
    done();
  };
  const play = (element: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions) => {
    animations.push(element.animate(frames, { fill: 'both', ...options }));
  };
  const easing = 'cubic-bezier(.22,1,.36,1)';
  const target = panel.getBoundingClientRect();
  const origin = trigger?.isConnected && !panel.contains(trigger) ? trigger.getBoundingClientRect() : null;
  const hasOrigin = origin && origin.width > 0 && origin.height > 0 && origin.bottom > 0 && origin.top < innerHeight;
  if (hasOrigin) {
    const shell = document.createElement('div');
    shell.className = 'agent-inspector-opening-shell'; shell.setAttribute('aria-hidden', 'true');
    const styles = getComputedStyle(panel);
    Object.assign(shell.style, { left: `${target.left}px`, top: `${target.top}px`, width: `${target.width}px`, height: `${target.height}px`, background: styles.backgroundColor, borderColor: styles.borderColor, borderRadius: styles.borderRadius });
    document.body.append(shell); artifacts.push(shell);
    play(shell, [
      { transform: `translate(${origin.left - target.left}px,${origin.top - target.top}px) scale(${origin.width / target.width},${origin.height / target.height})`, opacity: 1 },
      { transform: 'translate(0,0) scale(1)', opacity: 1, offset: .8 },
      { transform: 'translate(0,0) scale(1)', opacity: 0 },
    ], { duration: 520, easing });
    const fromIcon = trigger?.querySelector<HTMLImageElement>('.room-provider-badge img');
    const toIcon = panel.querySelector<HTMLImageElement>('.room-provider-badge img');
    if (fromIcon && toIcon && fromIcon.src === toIcon.src) {
      const from = fromIcon.getBoundingClientRect(); const to = toIcon.getBoundingClientRect();
      if (from.width && to.width) {
        const icon = toIcon.cloneNode() as HTMLImageElement;
        icon.className = 'agent-inspector-opening-avatar'; icon.alt = ''; icon.setAttribute('aria-hidden', 'true');
        Object.assign(icon.style, { left: `${to.left}px`, top: `${to.top}px`, width: `${to.width}px`, height: `${to.height}px` });
        document.body.append(icon); artifacts.push(icon);
        play(icon, [
          { transform: `translate(${from.left - to.left}px,${from.top - to.top}px) scale(${from.width / to.width})`, opacity: 1 },
          { transform: 'translate(0,0) scale(1)', opacity: 1, offset: .75 },
          { transform: 'translate(0,0) scale(1)', opacity: 0 },
        ], { duration: 480, easing });
      }
    }
  }
  const delay = hasOrigin ? 140 : 0;
  play(panel, [{ opacity: 0, transform: 'translateY(6px) scale(.99)' }, { opacity: 1, transform: 'translateY(0) scale(1)' }], { duration: 300, delay, easing });
  const layers = panel.querySelectorAll<HTMLElement>('.agent-inspector-identity, .agent-inspector-header-tools, :scope > .agent-inspector-signal, .agent-inspector-tabs, .agent-inspector-scroll-region, .agent-inspector-footer');
  layers.forEach((layer, index) => play(layer, [{ opacity: 0, transform: 'translateY(9px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 260, delay: delay + 20 + index * 24, easing }));
  preference.addEventListener('change', finish); window.addEventListener('resize', finish);
  void Promise.allSettled(animations.map(animation => animation.finished)).then(finish);
  return finish;
}
