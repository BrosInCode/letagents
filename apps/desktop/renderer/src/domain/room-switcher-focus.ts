export type RoomSwitcherFocusAction = "composer" | "main" | "none";

export interface ResolveRoomSwitcherFocusOptions<T = unknown> {
  composerElement?: T | null;
  mainElement?: T | null;
  isAvailable?: (element: T) => boolean;
}

export interface RoomSwitcherFocusDecision<T = unknown> {
  action: RoomSwitcherFocusAction;
  target: T | null;
}

export const DESKTOP_COMPOSER_SELECTOR = '[data-testid="desktop-composer-input"]:not([disabled])';
export const DESKTOP_ROOM_MAIN_SELECTOR = '[data-testid="desktop-room-shell"], [data-testid="desktop-main"], [role="main"], main';
export const DESKTOP_COMPOSER_LOADING_SELECTOR = '[data-testid="desktop-composer-loading"]';

function defaultIsAvailable(element: unknown): boolean {
  if (!element || typeof element !== "object") return false;
  if ("tagName" in element && typeof (element as { tagName: unknown }).tagName === "string") {
    if ((element as { tagName: string }).tagName.toLowerCase() === "body") {
      return false;
    }
  }
  if ("disabled" in element && Boolean((element as { disabled: unknown }).disabled)) {
    return false;
  }
  if ("isConnected" in element && !element.isConnected) return false;
  const target = element as HTMLElement;
  if (target.getClientRects && target.getClientRects().length === 0) return false;
  if (target.closest?.("[hidden], [inert]")) return false;
  const style = target.ownerDocument?.defaultView?.getComputedStyle(target);
  if (style?.visibility === "hidden" || style?.visibility === "collapse" || style?.display === "none") return false;
  return true;
}

/**
 * Pure decision function governing where keyboard focus lands after choosing a room
 * in the switcher.
 *
 * Rules:
 * 1. If the composer input is available in the room, focus the composer.
 * 2. If the destination has no composer (e.g. read-only, access required, or disabled),
 *    fall back to the room's main region, never to <body>.
 * 3. Choosing the room that is already open also focuses its composer.
 */
export function resolveRoomSwitcherFocusTarget<T = HTMLElement>(
  options: ResolveRoomSwitcherFocusOptions<T>,
): RoomSwitcherFocusDecision<T> {
  const isAvailable = options.isAvailable ?? (defaultIsAvailable as (element: T) => boolean);

  const composer = options.composerElement;
  if (composer && isAvailable(composer)) {
    return { action: "composer", target: composer };
  }

  const main = options.mainElement;
  if (main && isAvailable(main)) {
    return { action: "main", target: main };
  }

  return { action: "none", target: null };
}

export type RoomSwitcherActivationAction = "immediate" | "wait" | "abandon";

/**
 * Pure decision function determining how room switcher focus should synchronize with
 * room activation:
 * 1. "immediate": the chosen room is already active, so focus can start immediately.
 * 2. "wait": the chosen room is not yet active, so wait for it to become active.
 * 3. "abandon": the timeout expired before the chosen room became active; do nothing.
 */
export function resolveRoomSwitcherActivationAction(options: {
  currentRoomId: string | null | undefined;
  chosenRoomId: string;
  timedOut?: boolean;
}): RoomSwitcherActivationAction {
  if (options.currentRoomId === options.chosenRoomId) {
    return "immediate";
  }
  if (options.timedOut) {
    return "abandon";
  }
  return "wait";
}

export interface CoordinateRoomSwitcherFocusOptions {
  currentRoomId: () => string | null | undefined;
  chosenRoomId: string;
  startFocus: (isCurrent: () => boolean, onComplete: () => void) => (() => void) | void;
  watchRoomId?: (onChange: (roomId: string) => void) => (() => void);
  nextTick?: () => Promise<unknown>;
  timeoutMs?: number;
  setTimeoutFn?: (handler: () => void, ms: number) => any;
  clearTimeoutFn?: (id: any) => void;
}

/**
 * Coordinates focus application with room activation.
 *
 * Prevents focusing the previous room's composer before the shell unmounts:
 * - If chosen room is already active, starts focus immediately.
 * - Otherwise, watches active room until it equals chosen room, awaits nextTick, then starts.
 * - If timeout expires without activation, abandons focus (leaves focus where it is).
 * - Returns a cancel/cleanup function that stops watch/timers and cancels any active focus.
 */
export function coordinateRoomSwitcherFocus(options: CoordinateRoomSwitcherFocusOptions): () => void {
  let cleanedUp = false;
  let started = false;
  let cancelFocus: (() => void) | null = null;
  let unwatch: (() => void) | null = null;
  let timerId: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (timerId === null) return;
    (options.clearTimeoutFn ?? clearTimeout)(timerId);
    timerId = null;
  };
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearTimer();
    unwatch?.();
    unwatch = null;
    cancelFocus?.();
    cancelFocus = null;
  };
  const isCurrent = () => !cleanedUp && options.currentRoomId() === options.chosenRoomId;

  async function activate(waitForRender: boolean): Promise<void> {
    if (started || cleanedUp) return;
    started = true;
    if (waitForRender) await options.nextTick?.();
    if (!isCurrent()) {
      cleanup();
      return;
    }
    clearTimer();
    const cancel = options.startFocus(isCurrent, cleanup);
    if (cleanedUp) cancel?.();
    else cancelFocus = cancel ?? null;
  }

  // Keep ownership through nextTick and every pending animation frame, including
  // when the selected room was already active at the time of selection.
  unwatch = options.watchRoomId?.((newRoomId) => {
    if (newRoomId !== options.chosenRoomId) cleanup();
    else return activate(true);
  }) ?? null;
  if (resolveRoomSwitcherActivationAction({
    currentRoomId: options.currentRoomId(),
    chosenRoomId: options.chosenRoomId,
  }) === "immediate") {
    void activate(false);
  } else {
    timerId = (options.setTimeoutFn ?? setTimeout)(cleanup, options.timeoutMs ?? 1500);
  }
  return cleanup;
}

export interface FocusSwitchedRoomOptions {
  doc?: Document;
  timeoutMs?: number;
  isCurrent?: () => boolean;
  onComplete?: () => void;
  onFocus?: (decision: RoomSwitcherFocusDecision<HTMLElement>) => void;
}

/**
 * Schedules focus application once the switched room has rendered.
 *
 * Checks immediately and then via requestAnimationFrame. If the composer is loading
 * (skeleton visible), waits for the real composer input to mount. If the room has no
 * composer (e.g. read-only room, access required), lands focus on the main region.
 */
export function focusSwitchedRoomOnceRendered(options?: FocusSwitchedRoomOptions): () => void {
  const doc = options?.doc ?? (typeof document !== "undefined" ? document : null);
  if (!doc) {
    options?.onComplete?.();
    return () => {};
  }

  let cancelled = false;
  let frameId = 0;
  const startTime = Date.now();
  const timeoutMs = options?.timeoutMs ?? 1500;

  function attempt(): boolean {
    if (cancelled || options?.isCurrent?.() === false) return true;

    const composer = doc!.querySelector<HTMLElement>(DESKTOP_COMPOSER_SELECTOR);
    const mainRegion = Array.from(doc!.querySelectorAll<HTMLElement>(DESKTOP_ROOM_MAIN_SELECTOR))
      .find(defaultIsAvailable);

    const decision = resolveRoomSwitcherFocusTarget<HTMLElement>({
      composerElement: composer,
      mainElement: mainRegion,
    });

    if (decision.action === "composer" && decision.target) {
      decision.target.focus({ preventScroll: true });
      if (doc!.activeElement === decision.target) {
        options?.onFocus?.(decision);
        return true;
      }
    }

    // While composer skeleton loading indicator is present, wait for the actual
    // composer to finish mounting.
    const loading = doc!.querySelector(DESKTOP_COMPOSER_LOADING_SELECTOR);
    const isLoading = loading && defaultIsAvailable(loading);
    if (isLoading && Date.now() - startTime < timeoutMs) {
      return false;
    }

    // A visible input may still reject focus; only report success after checking
    // activeElement, and fall back to the visible main region if it does.
    if (mainRegion) {
      if (!mainRegion.hasAttribute("tabindex")) mainRegion.setAttribute("tabindex", "-1");
      mainRegion.focus({ preventScroll: true });
      if (doc!.activeElement === mainRegion) {
        options?.onFocus?.({ action: "main", target: mainRegion });
        return true;
      }
    }

    if (Date.now() - startTime >= timeoutMs) {
      return true;
    }

    return false;
  }

  function step(): void {
    if (attempt()) {
      options?.onComplete?.();
      return;
    }
    if (typeof requestAnimationFrame !== "undefined") {
      frameId = requestAnimationFrame(step);
    }
  }

  if (typeof requestAnimationFrame !== "undefined") {
    frameId = requestAnimationFrame(step);
  } else {
    step();
  }

  return () => {
    cancelled = true;
    if (frameId && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(frameId);
    }
  };
}
