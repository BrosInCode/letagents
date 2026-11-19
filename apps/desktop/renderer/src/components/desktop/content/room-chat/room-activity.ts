import type { ComposerEventPreview } from "./composer-event-preview";

/** How long a short notice stays on the activity line. */
export const ACTIVITY_NOTICE_MS = 4_000;
/** After a hover ends, a notice that has run out stays this long. */
export const ACTIVITY_RESUME_GRACE_MS = 800;
/** Notices waiting their turn; older ones leave first. */
export const ACTIVITY_NOTICE_LIMIT = 6;
/** A calm line with an action stays longer, so there is time to use it. */
export const ACTIVITY_ACTION_NOTICE_MS = 6_000;

/** What a calm line's one button does. */
export type CalmNoticeActionKey = "choose-attachment" | "retry-attachment";

/**
 * One calm line in plain words: "<lead><name><tail>", with the name in bold and
 * at most one action. Approval outcomes and attachment problems use it.
 */
export interface CalmNoticeInput {
  icon: "check" | "attach";
  lead: string;
  name?: string;
  tail?: string;
  action?: { key: CalmNoticeActionKey; label: string };
}

export type ActivityNotice =
  | { kind: "github"; id: string; preview: ComposerEventPreview }
  | { kind: "steered"; id: string; displayName: string }
  | ({ kind: "calm"; id: string } & CalmNoticeInput);

/** The words of a calm line, as one sentence for a screen reader. */
export function calmNoticeText(notice: CalmNoticeInput): string {
  return `${notice.lead}${notice.name ?? ""}${notice.tail ?? ""}`;
}

function noticeMs(notice: ActivityNotice): number {
  return notice.kind === "calm" && notice.action ? ACTIVITY_ACTION_NOTICE_MS : ACTIVITY_NOTICE_MS;
}

/** A confirmation of something already done; a newer one replaces it instead of queueing it again. */
function isConfirmation(notice: ActivityNotice): boolean {
  return notice.kind === "steered" || (notice.kind === "calm" && !notice.action);
}

export interface ActivityTimers {
  now(): number;
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/**
 * Short notices for the activity line, one at a time. Each shows for
 * ACTIVITY_NOTICE_MS; a hover holds it. A notice the caller cannot show now (a GitHub
 * update while someone writes) is skipped and keeps its place until its
 * source withdraws it.
 */
export function createActivityNoticeQueue(timers: ActivityTimers, onChange: () => void) {
  let queue: ActivityNotice[] = [];
  let shown: ActivityNotice | null = null;
  let remaining = 0;
  let resumedAt = 0;
  let timer: unknown = null;
  let paused = false;
  let eligible: (notice: ActivityNotice) => boolean = () => true;

  function stopTimer(): void {
    if (timer !== null) timers.clear(timer);
    timer = null;
  }

  function arm(ms: number): void {
    stopTimer();
    remaining = ms;
    resumedAt = timers.now();
    if (paused) return;
    timer = timers.set(() => { timer = null; advance(); }, ms);
  }

  function advance(): void {
    stopTimer();
    const index = queue.findIndex((notice) => eligible(notice));
    shown = index < 0 ? null : queue.splice(index, 1)[0]!;
    if (shown) {
      arm(noticeMs(shown));
    }
    onChange();
  }

  function push(notice: ActivityNotice): void {
    queue = [...queue.filter((item) => item.id !== notice.id), notice].slice(-ACTIVITY_NOTICE_LIMIT);
    if (!shown) advance();
  }

  /** Show a notice before the others, now (a confirmation of the person's own action). */
  function pushFirst(notice: ActivityNotice): void {
    // The covered notice shows again after it, unless it is an older confirmation.
    if (shown && !isConfirmation(shown)) queue = [shown, ...queue].slice(0, ACTIVITY_NOTICE_LIMIT);
    queue = [notice, ...queue.filter((item) => item.id !== notice.id)];
    advance();
  }

  /** The source of a notice withdrew it (a GitHub update expired or was dismissed). */
  function remove(id: string): void {
    queue = queue.filter((notice) => notice.id !== id);
    if (shown?.id === id) advance();
  }

  return {
    push,
    pushFirst,
    remove,
    current: () => shown,
    waiting: () => queue,
    /** A hover holds the notice on screen; its time left runs again when the hover ends. */
    pause(): void {
      if (paused) return;
      paused = true;
      if (timer !== null) remaining = Math.max(0, remaining - (timers.now() - resumedAt));
      stopTimer();
    },
    resume(): void {
      if (!paused) return;
      paused = false;
      if (shown) arm(Math.max(remaining, ACTIVITY_RESUME_GRACE_MS));
      else advance();
    },
    /** Which notices can show now. A shown notice that no longer can gives way. */
    setEligible(test: (notice: ActivityNotice) => boolean): void {
      eligible = test;
      // A notice put away keeps its place at the front, so it comes back when it can show again.
      if (shown && !test(shown)) { queue = [shown, ...queue]; advance(); }
      else if (!shown && queue.some(test)) advance();
    },
    clear(): void {
      stopTimer();
      queue = [];
      shown = null;
      paused = false;
      onChange();
    },
  };
}

export interface ActivitySteerOffer {
  entryId: string;
  displayName: string;
}

/**
 * The Steer offer for a draft's target. It returns `previous` while the target
 * is the same agent, so typing more of the draft does not redraw the timeline.
 */
export function stableSteerOffer(
  previous: ActivitySteerOffer | null | undefined,
  target: ActivitySteerOffer | null | undefined,
): ActivitySteerOffer | null {
  if (!target) return null;
  const { entryId, displayName } = target;
  return previous?.entryId === entryId && previous.displayName === displayName ? previous : { entryId, displayName };
}

export interface ActivityWork {
  id: string;
  displayName: string;
}

export type ActivityPill<W extends ActivityWork = ActivityWork> =
  | { kind: "steer"; offer: ActivitySteerOffer }
  | { kind: "notice"; notice: ActivityNotice }
  | { kind: "live"; work: readonly W[] }
  | { kind: "typing"; names: readonly string[] }
  | null;

/** The one pill the line shows: Steer offer, then a notice, then live work, then typing. */
export function pickActivityPill<W extends ActivityWork>(input: {
  steer: ActivitySteerOffer | null;
  notice: ActivityNotice | null;
  work: readonly W[];
  typing: readonly string[];
}): ActivityPill<W> {
  if (input.steer) return { kind: "steer", offer: input.steer };
  if (input.notice) return { kind: "notice", notice: input.notice };
  if (input.work.length) return { kind: "live", work: input.work };
  if (input.typing.length) return { kind: "typing", names: input.typing };
  return null;
}

/** Whole seconds, then minutes: "8s", "2m". */
export function elapsedLabel(startedAt: string, now: number): string {
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return "";
  const seconds = Math.max(1, Math.round((now - started) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`;
}
