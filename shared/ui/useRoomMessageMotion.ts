import { inject, nextTick, onBeforeUnmount, onDeactivated, onMounted, provide, ref, watch, type InjectionKey, type Ref } from 'vue';
import { appendedMotionMessages, captureWork, createRoomMessageAnimator, sameMotionAgent, type MotionMessage, type WorkGeometry } from './room-message-motion';

interface SendOrigin {
  text: string; bounds: DOMRect; composer: HTMLElement | null; keyboard: boolean; messageId?: string;
}
function createSendContext() {
  const revision = ref(0);
  let pending: SendOrigin | null = null;
  return {
    revision,
    capture(text: string, input: HTMLTextAreaElement | null) {
      if (!input) return () => {};
      const origin = { text, bounds: input.getBoundingClientRect(), composer: input.closest<HTMLElement>('form, .desktop-composer, .composer-card'), keyboard: document.activeElement === input };
      pending = origin;
      return () => { if (pending === origin) pending = null; };
    },
    confirmation(text: string) {
      const origin = pending?.text === text ? pending : null;
      return (messageId: string) => {
        if (origin && pending === origin) { origin.messageId = messageId; revision.value++; }
      };
    },
    consume(message: MotionMessage) {
      if (!pending || !(pending.messageId ? pending.messageId === message.id : message.outgoing && pending.text === message.text)) return null;
      const result = pending; pending = null; return result;
    },
    peekId() { return pending?.messageId; },
    clear() { pending = null; },
  };
}
const sendKey: InjectionKey<ReturnType<typeof createSendContext>> = Symbol('room-message-send-motion');
export function provideRoomMessageMotion(scope: () => string | null | undefined) {
  const context = createSendContext();
  provide(sendKey, context);
  watch(scope, context.clear, { flush: 'sync' });
  onBeforeUnmount(context.clear);
  onDeactivated(context.clear);
  return context;
}
export function injectRoomMessageMotion() { return inject(sendKey, null); }

/** The list still owns scrolling/history. Motion observes only fresh, visible arrivals. */
export function useRoomMessageMotion(options: {
  element: Ref<HTMLElement | null>;
  messages: () => MotionMessage[];
  scope: () => string | null | undefined;
  ready: () => boolean;
  following: () => boolean;
}) {
  const send = injectRoomMessageMotion();
  const animator = createRoomMessageAnimator(() => options.element.value);
  let previous = options.messages().map(message => message.stableId);
  let revision = 0;
  let media: MediaQueryList | null = null;
  const cancel = () => { revision++; animator.cancel(); };
  watch(options.scope, () => { cancel(); previous = options.messages().map(message => message.stableId); }, { flush: 'sync' });
  watch(options.ready, ready => { if (!ready) cancel(); });
  watch([options.messages, () => send?.revision.value], async ([messages]) => {
    const appended = appendedMotionMessages(previous, messages);
    previous = messages.map(message => message.stableId);
    // A first message in an empty room is allowed only when this composer sent it.
    // Exact API acknowledgements also handle a websocket echo winning the race.
    const outgoing = messages.find(message => message.id === send?.peekId() || message.outgoing);
    const candidates = [...appended];
    if (outgoing && !candidates.includes(outgoing)) candidates.push(outgoing);
    const sends = new Map<string, SendOrigin>();
    for (const message of candidates) { const source = send?.consume(message); if (source) sends.set(message.id, source); }
    if (!appended.length && !sends.size) return;
    cancel();
    const currentRevision = revision;
    const element = options.element.value;
    if (!element || !options.ready() || !options.following() || media?.matches || document.visibilityState === 'hidden') return;
    const positions = new Map([...element.querySelectorAll<HTMLElement>('[data-message-id], [data-msg-id]')].map(row => [row, row.getBoundingClientRect()]));
    const sources = new Map<string, WorkGeometry>();
    const used = new Set<HTMLElement>();
    const workRows = [...element.querySelectorAll<HTMLElement>('[data-motion-work]')];
    for (const message of appended) {
      const matches = workRows.filter(work => !used.has(work) && sameMotionAgent(message, { session: work.dataset.motionSession, key: work.dataset.motionAgent })
        && (!work.dataset.motionAfter || (messages.findIndex(item => item.id === work.dataset.motionAfter) >= 0 && messages.findIndex(item => item.id === work.dataset.motionAfter) < messages.indexOf(message))));
      if (matches.length !== 1) continue;
      const source = captureWork(matches[0]);
      if (source) { sources.set(message.id, source); used.add(matches[0]); }
    }
    await nextTick();
    // Scroll followers may themselves be queued by this render (e.g. an API acknowledgement).
    await nextTick();
    if (currentRevision !== revision || !options.ready() || media?.matches || element !== options.element.value) return;
    animator.move(positions);
    const rows = [...element.querySelectorAll<HTMLElement>('[data-message-id], [data-msg-id]')];
    for (const message of candidates) {
      const row = rows.find(row => (row.dataset.messageId || row.dataset.msgId) === message.id);
      if (!row) continue;
      const bounds = row.getBoundingClientRect(), viewport = element.getBoundingClientRect();
      if (bounds.bottom < viewport.top || bounds.top > viewport.bottom) continue;
      const origin = sends.get(message.id), work = sources.get(message.id);
      if (origin) animator.send(row, origin.bounds, origin.composer, origin.keyboard);
      else if (work) animator.reply(row, work);
      else if (appended.includes(message)) animator.reveal(row);
    }
  });
  const onKey = (event: KeyboardEvent) => { if (['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown'].includes(event.key)) cancel(); };
  onMounted(() => {
    media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    media?.addEventListener('change', cancel);
    window.addEventListener('resize', cancel);
    options.element.value?.addEventListener('wheel', cancel, { passive: true });
    options.element.value?.addEventListener('touchstart', cancel, { passive: true });
    options.element.value?.addEventListener('pointerdown', cancel, { passive: true });
    options.element.value?.addEventListener('keydown', onKey);
  });
  onDeactivated(cancel);
  onBeforeUnmount(() => {
    cancel(); media?.removeEventListener('change', cancel); window.removeEventListener('resize', cancel);
    options.element.value?.removeEventListener('wheel', cancel);
    options.element.value?.removeEventListener('touchstart', cancel);
    options.element.value?.removeEventListener('pointerdown', cancel);
    options.element.value?.removeEventListener('keydown', onKey);
  });
  return { cancel };
}
