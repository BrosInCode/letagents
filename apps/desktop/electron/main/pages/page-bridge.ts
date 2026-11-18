import type { WebContents, WebFrameMain } from "electron";

import { takeInlineHtmlDemoTokens } from "../attachments/html-demo-policy.js";
import type { PageApiAdapter, PageCallContext } from "./page-adapter.js";
import type { PageConfirmBroker } from "./page-confirm.js";
import type { PageDiagnostic, PageDiagnosticsKey } from "./page-diagnostics.js";
import type { RoomPageLease } from "./page-host.js";
import type { PageWatches } from "./page-watch.js";
import {
  isPageMethodName,
  MAX_PAGE_CALL_INPUT_CHARS,
  MAX_PAGE_COPY_CHARS,
  PAGE_BUILTIN_METHODS,
  PAGE_OPEN_INTERVAL_MS,
  PAGE_PERSON_INPUT_WINDOW_MS,
  PageCallFailure,
  pageOpenTarget,
  type PageCallResult,
  type PageTheme,
} from "./page-policy.js";

/** The signed-in person a page runs for. */
export interface PageViewer {
  id: string;
  login: string;
  displayName: string | null;
}

export interface PageBridgeDeps {
  /** The live page lease of the sender's main frame; null refuses the call. */
  leaseFor(sender: WebContents, frame: WebFrameMain | null): RoomPageLease | null;
  adapter: PageApiAdapter;
  /** The contract methods the adapter serves. */
  methods: ReadonlySet<string>;
  confirm: PageConfirmBroker;
  viewer(): Promise<PageViewer | null>;
  theme(): PageTheme;
  openExternal(url: string): Promise<void>;
  writeClipboard(text: string): void;
  /** The page's watches; without them `events.watch` is `not_found`. */
  watches?: PageWatches<RoomPageLease>;
  /** Keep a failed call in the page's diagnostics. */
  record(key: PageDiagnosticsKey, entry: Omit<Extract<PageDiagnostic, { kind: "call" }>, "at">): void;
  now?: () => number;
}

/** What a sandboxed guest's `ipcRenderer.invoke` gives main. */
export interface PageCallEvent {
  sender: WebContents;
  senderFrame: WebFrameMain | null;
}

/**
 * The main side of `page:call`, the only channel a room page has. In order:
 * the sender must be a live page lease's own main frame (not the app window,
 * not a demo), the page must be inside its call rate, the method must exist
 * and the input must fit, and only then does main answer it or hand it to the
 * API adapter. Every
 * outcome is a value, never a thrown error, so the page gets the error code.
 */
export function createPageCallHandler(deps: PageBridgeDeps) {
  const now = deps.now ?? Date.now;

  async function builtin(lease: RoomPageLease, method: string, input: unknown): Promise<unknown> {
    const page = { id: lease.page.id, title: lease.page.title, version: lease.page.version };
    switch (method) {
      case "page.get":
        return page;
      case "viewer.get":
        return requireViewer(await deps.viewer());
      case "ui.theme":
        return deps.theme();
      case "ui.context":
        return { surface: "room.tab", room: { id: lease.roomId }, page, viewer: requireViewer(await deps.viewer()) };
      case "ui.open":
        return openLink(lease, input);
      case "ui.copy":
        return copyText(lease, input);
      case "events.watch":
        if (!deps.watches) throw new PageCallFailure("not_found", "Watches are not available in this app yet.");
        deps.watches.start(lease, field(input, "id"), field(input, "method"), field(input, "input") ?? null);
        return null;
      case "events.unwatch":
        deps.watches?.stop(lease, field(input, "id"));
        return null;
      default:
        throw new PageCallFailure("not_found", `There is no method "${method}".`);
    }
  }

  /** Leases with a confirm sheet open or being asked for; set before any await, so a burst gets one. */
  const confirming = new WeakSet<RoomPageLease>();

  /**
   * Opening, copying and asking for a sheet work only for the page in the
   * active tab, right after the person's own click or key press in it: main
   * saw that input itself, and the page cannot fake it.
   */
  function assertPersonPresent(lease: RoomPageLease, action: string): void {
    if (!lease.visible) throw new PageCallFailure("not_granted", `${action} works only from the page in the open tab.`);
    if (now() - lease.lastInputAt > PAGE_PERSON_INPUT_WINDOW_MS) {
      throw new PageCallFailure("not_granted", `${action} works only right after a click or key press in the page.`);
    }
  }

  async function openLink(lease: RoomPageLease, input: unknown): Promise<null> {
    const target = pageOpenTarget(field(input, "url"));
    if (!target) throw new PageCallFailure("not_granted", "A page can open only https links.");
    assertPersonPresent(lease, "ui.open");
    const time = now();
    const wait = lease.lastOpenAt + PAGE_OPEN_INTERVAL_MS - time;
    if (wait > 0) throw new PageCallFailure("rate_limited", "A page can open one link every 2 seconds.", Math.ceil(wait));
    if (confirming.has(lease)) throw new PageCallFailure("rate_limited", "Answer the open question first.", 1_000);
    lease.lastOpenAt = time;
    if (!lease.openDomains.has(target.domain)) {
      confirming.add(lease);
      try {
        const viewer = requireViewer(await deps.viewer());
        // The first link to a new domain asks; later ones from this open page go ahead.
        const answer = await deps.confirm.ask(lease, scopeOf(lease, viewer), {
          kind: "open",
          pageTitle: lease.page.title,
          text: target.url,
          target: target.domain,
          rememberable: false,
          choice: `open:${target.domain}`,
        });
        if (answer !== "confirmed") throw new PageCallFailure("declined", "The link was not opened.");
      } finally {
        confirming.delete(lease);
      }
      lease.openDomains.add(target.domain);
    }
    await deps.openExternal(target.url);
    return null;
  }

  /**
   * A call that acts as the person (an agent job now; posts and intents when
   * their routes land) first shows the app-drawn sheet with the exact text and
   * target. A no sends nothing. Only the page in the open tab may ask.
   */
  async function confirmCall(lease: RoomPageLease, method: string, input: unknown): Promise<void> {
    const describe = CONFIRMED_METHODS[method];
    if (!describe) return;
    const sheet = describe(input);
    if (!sheet) throw new PageCallFailure("invalid_input", `${method} needs its text before it can be confirmed.`);
    if (!lease.visible) throw new PageCallFailure("not_granted", `${method} works only from the page in the open tab.`);
    if (confirming.has(lease)) throw new PageCallFailure("rate_limited", "Answer the open question first.", 1_000);
    confirming.add(lease);
    try {
      const viewer = requireViewer(await deps.viewer());
      const answer = await deps.confirm.ask(lease, scopeOf(lease, viewer), {
        ...sheet,
        pageTitle: lease.page.title,
        rememberable: true,
        choice: method,
      });
      if (answer !== "confirmed") throw new PageCallFailure("declined", "The person said no, so nothing was sent.");
    } finally {
      confirming.delete(lease);
    }
  }

  function copyText(lease: RoomPageLease, input: unknown): null {
    const text = field(input, "text");
    if (typeof text !== "string") throw new PageCallFailure("invalid_input", "ui.copy takes plain text.");
    if (text.length > MAX_PAGE_COPY_CHARS) throw new PageCallFailure("too_large", `ui.copy takes at most ${MAX_PAGE_COPY_CHARS} characters.`);
    assertPersonPresent(lease, "ui.copy");
    deps.writeClipboard(text);
    return null;
  }

  function takeCall(lease: RoomPageLease): void {
    const bucket = lease.calls;
    if (takeInlineHtmlDemoTokens(bucket, 1, now())) return;
    // A refused call does not count, so a page that waits gets its next call.
    bucket.tokens += 1;
    const retryAfterMs = Math.max(1, Math.ceil(((1 - bucket.tokens) / bucket.perSecond) * 1000));
    throw new PageCallFailure("rate_limited", "This page is making calls too fast.", retryAfterMs);
  }

  return async function handlePageCall(event: PageCallEvent, payload: unknown): Promise<PageCallResult> {
    const lease = deps.leaseFor(event.sender, event.senderFrame);
    if (!lease) return { ok: false, error: { code: "not_granted", message: "Only a room page can use this bridge." } };
    let method: unknown = "";
    try {
      // The rate comes first: a refused or malformed call costs the page a token too.
      takeCall(lease);
      method = field(payload, "method");
      const input = field(payload, "input") ?? null;
      if (!isPageMethodName(method) || !(PAGE_BUILTIN_METHODS.has(method) || deps.methods.has(method))) {
        throw new PageCallFailure("not_found", `There is no method "${typeof method === "string" ? method.slice(0, 100) : ""}".`);
      }
      if (inputChars(input) > MAX_PAGE_CALL_INPUT_CHARS) {
        throw new PageCallFailure("too_large", `A call's input may be at most ${MAX_PAGE_CALL_INPUT_CHARS} characters of JSON.`);
      }
      let value: unknown;
      if (PAGE_BUILTIN_METHODS.has(method)) {
        value = await builtin(lease, method, input);
      } else {
        await confirmCall(lease, method, input);
        value = await deps.adapter.call(contextOf(lease), method, input);
      }
      return { ok: true, value: value === undefined ? null : value };
    } catch (error) {
      const failure = error instanceof PageCallFailure
        ? error
        : new PageCallFailure("source_unavailable", "The call failed. Try again in a moment.");
      deps.record(contextOf(lease), {
        kind: "call",
        method: typeof method === "string" ? method : "",
        code: failure.code,
        message: failure.message,
      });
      return { ok: false, error: failure.toError() };
    }
  };
}

/** The sheet each confirmed method shows: the exact text the call sends, and where it goes. */
const CONFIRMED_METHODS: Readonly<Record<string, (input: unknown) => { kind: "job" | "post" | "intent"; text: string; target: string } | null>> = {
  "jobs.start": (input) => {
    const instruction = field(input, "instruction");
    if (typeof instruction !== "string" || !instruction.trim()) return null;
    const agent = field(input, "agent");
    return { kind: "job", text: instruction, target: typeof agent === "string" && agent.trim() ? agent : "Any online agent" };
  },
  // A page viewer cannot read the room's policy (rooms.listPolicies is admin
  // only), so every proposal asks: the sheet is required under `confirm` and
  // only one more yes under `allow` or `approve`.
  "intents.propose": (input) => describeIntent(field(input, "kind"), field(input, "payload")),
};

const TASK_STATUS_WORDS: Readonly<Record<string, string>> = {
  proposed: "Proposed", accepted: "Accepted", assigned: "Assigned", in_progress: "In progress", blocked: "Blocked",
  in_review: "In review", merged: "Merged", done: "Done", cancelled: "Cancelled",
};

/**
 * An intent in plain words, from its kind and payload, such as "Move DS-7 to
 * Released". Every value the change sends is in the text; null for a payload
 * the server would refuse anyway.
 */
export function describeIntent(kind: unknown, payload: unknown): { kind: "intent"; text: string; target: string } | null {
  const text = (name: string): string | null => {
    const value = field(payload, name);
    return typeof value === "string" && value.trim() ? value.trim() : null;
  };
  switch (kind) {
    case "task.create": {
      const title = text("title");
      if (!title) return null;
      const description = text("description");
      return { kind: "intent", text: `Create the task "${title}"${description ? `\n\n${description}` : ""}`, target: "This room's board" };
    }
    case "task.update": {
      const taskId = text("taskId");
      if (!taskId) return null;
      const changes: string[] = [];
      const status = text("status");
      if (status) changes.push(`move it to ${TASK_STATUS_WORDS[status] ?? status}`);
      const assignee = field(payload, "assignee");
      const agentKey = field(payload, "assigneeAgentKey");
      if (assignee === null || agentKey === null) changes.push("remove its assignee");
      else if (typeof assignee === "string" || typeof agentKey === "string") changes.push(`assign it to ${text("assignee") ?? text("assigneeAgentKey")}`);
      const title = text("title");
      if (title) changes.push(`rename it to "${title}"`);
      if (typeof field(payload, "description") === "string") changes.push("replace its description");
      if (changes.length === 0) return null;
      const description = typeof field(payload, "description") === "string" ? `\n\nNew description:\n${field(payload, "description") as string}` : "";
      return { kind: "intent", text: `Task ${taskId}: ${changes.join("; ")}${description}`, target: "This room's board" };
    }
    case "ticket.transition": {
      const key = text("key");
      const toStatus = text("toStatus");
      return key && toStatus ? { kind: "intent", text: `Move ${key} to ${toStatus}`, target: `${key} in this room's tracker` } : null;
    }
    case "ticket.comment": {
      const key = text("key");
      const body = text("body");
      return key && body ? { kind: "intent", text: `Comment on ${key}:\n\n${body}`, target: `${key} in this room's tracker` } : null;
    }
    default:
      return null;
  }
}

export function contextOf(lease: RoomPageLease): PageCallContext {
  return { leaseId: lease.host, roomId: lease.roomId, pageId: lease.page.id, version: lease.page.version };
}

function scopeOf(lease: RoomPageLease, viewer: PageViewer) {
  return { viewerId: viewer.id, ...contextOf(lease) };
}

function requireViewer(viewer: PageViewer | null): PageViewer {
  if (!viewer) throw new PageCallFailure("unauthenticated", "Sign in to LetAgents to use this page.");
  return viewer;
}

function field(value: unknown, name: string): unknown {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)[name] : undefined;
}

/** The input's JSON length; input that has no JSON form (a cycle, say) counts as too large. */
function inputChars(input: unknown): number {
  try {
    return JSON.stringify(input)?.length ?? 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
