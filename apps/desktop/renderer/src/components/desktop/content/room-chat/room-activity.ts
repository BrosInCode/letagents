import type { PresenceChipAgent } from "../../../../domain/presence-chips";
import type { ComposerEventPreview } from "./composer-event-preview";

/** How long a short notice stays on the activity line. */
export const ACTIVITY_NOTICE_MS = 4_000;
/** A join that arrives this soon after a join is shown joins that line. */
export const ACTIVITY_JOIN_MERGE_MS = 1_500;
/** After a hover ends, a notice that has run out stays this long. */
export const ACTIVITY_RESUME_GRACE_MS = 800;
/** Notices waiting their turn; older ones leave first. */
export const ACTIVITY_NOTICE_LIMIT = 6;

export type ActivityNotice =
  | { kind: "join"; id: string; agents: PresenceChipAgent[] }
  | { kind: "leave"; id: string; agent: PresenceChipAgent }
  | { kind: "github"; id: string; preview: ComposerEventPreview }
  | { kind: "steered"; id: string; displayName: string };

export interface ActivityTimers {
  now(): number;
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** "Juniper", "Juniper and Kestrel", "Juniper and 2 others". */
export function joinedNames(agents: readonly Pick<PresenceChipAgent, "displayName">[]): string {
  const names = agents.map((agent) => agent.displayName);
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} and ${names.length - 1} others`;
}

function noticeAgentKeys(notice: ActivityNotice): string[] {
  if (notice.kind === "join") return notice.agents.map((agent) => agent.key);
  if (notice.kind === "leave") return [notice.agent.key];
  return [];
}

/**
 * Short notices for the activity line, one at a time. Each shows for
 * ACTIVITY_NOTICE_MS; a hover holds it. Joins close together become one
 * notice, and an agent has at most one waiting notice: a newer change for it
 * replaces the older one. A notice the caller cannot show now (a GitHub
 * update while someone writes) is skipped and keeps its place until its
 * source withdraws it.
 */
export function createActivityNoticeQueue(timers: ActivityTimers, onChange: () => void) {
  let queue: ActivityNotice[] = [];
  let shown: ActivityNotice | null = null;
  let shownAt = 0;
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
      shownAt = timers.now();
      arm(ACTIVITY_NOTICE_MS);
    }
    onChange();
  }

  /** Drop waiting notices about these agents, so each agent has one. */
  function dropAgents(keys: readonly string[]): void {
    if (!keys.length) return;
    queue = queue.flatMap<ActivityNotice>((notice) => {
      if (notice.kind === "leave") return keys.includes(notice.agent.key) ? [] : [notice];
      if (notice.kind !== "join") return [notice];
      const agents = notice.agents.filter((agent) => !keys.includes(agent.key));
      return agents.length ? [{ ...notice, agents }] : [];
    });
  }

  function push(notice: ActivityNotice): void {
    dropAgents(noticeAgentKeys(notice));
    if (notice.kind === "join") {
      const last = queue.at(-1);
      if (last?.kind === "join") {
        queue[queue.length - 1] = { ...last, agents: [...last.agents, ...notice.agents] };
        return;
      }
      if (shown?.kind === "join" && timers.now() - shownAt < ACTIVITY_JOIN_MERGE_MS) {
        const present = new Set(shown.agents.map((agent) => agent.key));
        shown = { ...shown, agents: [...shown.agents, ...notice.agents.filter((agent) => !present.has(agent.key))] };
        // The longer line gets its own full time on screen.
        shownAt = timers.now();
        arm(ACTIVITY_NOTICE_MS);
        onChange();
        return;
      }
    }
    queue = [...queue.filter((item) => item.id !== notice.id), notice].slice(-ACTIVITY_NOTICE_LIMIT);
    if (!shown) advance();
  }

  /** Show a notice before the others, now (a confirmation of the person's own action). */
  function pushFirst(notice: ActivityNotice): void {
    // The covered notice shows again after it, unless it is an older confirmation.
    if (shown && shown.kind !== "steered") queue = [shown, ...queue].slice(0, ACTIVITY_NOTICE_LIMIT);
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

/** A quiet timeline line for a join or a leave, kept only in this window. */
export interface PresenceTimelineLine {
  id: string;
  timestamp: string;
  kind: "connected" | "disconnected";
  text: string;
}

export function presenceTimelineText(kind: PresenceTimelineLine["kind"], agent: PresenceChipAgent): string {
  if (kind === "disconnected") return `${agent.displayName} left`;
  return agent.ideLabel ? `${agent.displayName} joined · ${agent.ideLabel}` : `${agent.displayName} joined`;
}

/** Whole seconds, then minutes: "8s", "2m". */
export function elapsedLabel(startedAt: string, now: number): string {
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return "";
  const seconds = Math.max(1, Math.round((now - started) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`;
}
