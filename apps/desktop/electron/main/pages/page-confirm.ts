import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { letagentsHomePath } from "../../../../../shared/letagents-home.mjs";
import type {
  DesktopPageConfirmAnswer,
  DesktopPageConfirmKind,
  DesktopPageConfirmRequest,
} from "../../ipc-types.js";

/** The most remembered choices kept per file; the oldest go first. */
export const MAX_PAGE_CHOICES = 2_000;
/** The most the sheet shows, scrolling; a call with more is refused, never cut. */
export const MAX_PAGE_CONFIRM_TEXT = 20_000;
export const MAX_PAGE_CONFIRM_TARGET = 400;
export const MAX_PAGE_CONFIRM_DETAILS = 100_000;

/**
 * Choices a viewer made in confirm sheets that hold for one page version:
 * "Don't ask again", and domains `ui.open` may open without asking.
 */
export interface PageChoiceStore {
  has(key: string): Promise<boolean>;
  add(key: string): Promise<void>;
}

/** The page version and viewer a choice is for; a new version or another viewer asks again. */
export interface PageChoiceScope {
  viewerId: string;
  roomId: string;
  pageId: string;
  version: number;
}

export function pageChoiceKey(scope: PageChoiceScope, choice: string): string {
  return JSON.stringify([scope.viewerId, scope.roomId, scope.pageId, scope.version, choice]);
}

export function createMemoryPageChoiceStore(): PageChoiceStore & { keys: Set<string> } {
  const keys = new Set<string>();
  return {
    keys,
    async has(key) { return keys.has(key); },
    async add(key) { keys.add(key); },
  };
}

/** Choices in a small JSON file in the LetAgents home, so they survive a restart. */
export function createFilePageChoiceStore(
  path = process.env.LETAGENTS_PAGE_CHOICES_PATH?.trim() || letagentsHomePath("page-choices.json"),
): PageChoiceStore {
  let loaded: Promise<string[]> | null = null;
  let writing = Promise.resolve();
  const load = () => {
    loaded ??= readFile(path, "utf8")
      .then((text) => {
        const parsed = JSON.parse(text) as { choices?: unknown };
        return Array.isArray(parsed.choices) ? parsed.choices.filter((key): key is string => typeof key === "string") : [];
      })
      .catch(() => []);
    return loaded;
  };
  return {
    async has(key) {
      return (await load()).includes(key);
    },
    async add(key) {
      const choices = await load();
      if (choices.includes(key)) return;
      choices.push(key);
      if (choices.length > MAX_PAGE_CHOICES) choices.splice(0, choices.length - MAX_PAGE_CHOICES);
      const text = `${JSON.stringify({ choices }, null, 2)}\n`;
      writing = writing.then(async () => {
        await mkdir(dirname(path), { recursive: true });
        const temporary = `${path}.${randomUUID()}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      }).catch(() => undefined);
      await writing;
    },
  };
}

export interface PageConfirmAsk {
  kind: DesktopPageConfirmKind;
  pageTitle: string;
  text: string;
  target: string;
  details?: string | null;
  /** Offer "Don't ask again for this page version"; a remembered yes skips the sheet. */
  rememberable: boolean;
  /** A yes is remembered without the box: `ui.open` asks once per new domain. */
  rememberOnConfirm?: boolean;
  /** The choice the sheet decides, such as `post` or `open:example.com`. */
  choice: string;
}

/**
 * The app-drawn confirm sheet: main asks the app window, which shows exactly
 * the text and target given, and waits for the person. A page never draws or
 * answers it. Requests end "declined" when the window cannot show them, when
 * their page closes, or when the person says no.
 */
export function createPageConfirmBroker(deps: {
  /** Shows the sheet; false when there is no window to show it in. */
  show(request: DesktopPageConfirmRequest): boolean;
  /** Takes a sheet down that was answered for another reason (its page closed). */
  dismiss?(id: string): void;
  choices: PageChoiceStore;
}) {
  const pending = new Map<string, { owner: object; resolve: (answer: DesktopPageConfirmAnswer) => void; remember: (yes: boolean) => Promise<void> }>();

  async function ask(owner: object, scope: PageChoiceScope, input: PageConfirmAsk): Promise<DesktopPageConfirmAnswer> {
    // The person must see everything the call sends: text the sheet would cut is a no, never a partial yes.
    if (!fitsPageConfirmSheet(input)) return "declined";
    const key = pageChoiceKey(scope, input.choice);
    if ((input.rememberable || input.rememberOnConfirm) && await deps.choices.has(key)) return "confirmed";
    const request: DesktopPageConfirmRequest = {
      id: randomUUID(),
      kind: input.kind,
      pageTitle: input.pageTitle.slice(0, 80),
      pageVersion: scope.version,
      text: input.text,
      target: input.target,
      details: input.details ?? null,
      rememberable: input.rememberable,
    };
    return new Promise<DesktopPageConfirmAnswer>((resolve) => {
      pending.set(request.id, {
        owner,
        resolve,
        remember: async (yes) => {
          if (input.rememberOnConfirm || (input.rememberable && yes)) await deps.choices.add(key);
        },
      });
      if (!deps.show(request)) settle(request.id, "declined", false);
    });
  }

  function settle(id: string, answer: DesktopPageConfirmAnswer, remember: boolean): void {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (answer === "confirmed") {
      void entry.remember(remember).catch(() => undefined).finally(() => entry.resolve(answer));
      return;
    }
    entry.resolve(answer);
  }

  return {
    ask,
    /** The person's answer from the app window. Unknown or settled ids are ignored. */
    answer(id: unknown, answer: unknown, remember: unknown): void {
      if (typeof id !== "string") return;
      settle(id, answer === "confirmed" ? "confirmed" : "declined", remember === true);
    },
    /** Decline every open sheet of one page, as when its lease ends. */
    declineFor(owner: object): void {
      for (const [id, entry] of pending) {
        if (entry.owner !== owner) continue;
        settle(id, "declined", false);
        deps.dismiss?.(id);
      }
    },
    pendingFor(owner: object): number {
      let count = 0;
      for (const entry of pending.values()) if (entry.owner === owner) count += 1;
      return count;
    },
  };
}

export type PageConfirmBroker = ReturnType<typeof createPageConfirmBroker>;

/** Whether the sheet can show all of it. */
export function fitsPageConfirmSheet(input: { text: string; target: string; details?: string | null }): boolean {
  return input.text.length <= MAX_PAGE_CONFIRM_TEXT
    && input.target.length <= MAX_PAGE_CONFIRM_TARGET
    && (input.details ?? "").length <= MAX_PAGE_CONFIRM_DETAILS;
}
