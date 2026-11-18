// The preload of a room page, and nothing else: main sets it only on a page
// lease's webview. It stays small: main checks, confirms, rate-limits and
// re-runs watches; this file only names methods and keeps callbacks. It runs sandboxed, so it must be CommonJS (tsc writes this
// .cts file as page-preload.cjs), and it may use only `contextBridge` and
// `ipcRenderer`. Every call goes over one channel, `page:call`; main checks
// the sender, the method and the rate there. Main pushes events (the theme)
// on the same channel.
import { contextBridge, ipcRenderer } from "electron";

const CHANNEL = "page:call";

type PageError = { code: string; message: string; retryAfterMs?: number };
type PageResult = { ok: true; value: unknown } | { ok: false; error: PageError };
type PageTheme = { mode: "light" | "dark"; tokens: Record<string, string> };

async function call(method: string, input?: unknown): Promise<unknown> {
  const result = await ipcRenderer.invoke(CHANNEL, { method, input: input ?? null }) as PageResult | undefined;
  if (result?.ok) return result.value;
  // A plain object crosses contextBridge whole; an Error would arrive without its code.
  throw result && !result.ok ? { ...result.error } : { code: "source_unavailable", message: "The call failed." };
}

function name(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw { code: "not_found", message: `${label} must be a name.` };
  return value;
}

const themeListeners = new Set<(theme: PageTheme) => void>();

/** The app's colours as `--la-*` variables on the page root, so plain CSS can use them. */
function applyTheme(theme: PageTheme): void {
  const root = document.documentElement;
  if (!root) {
    window.addEventListener("DOMContentLoaded", () => applyTheme(theme), { once: true });
    return;
  }
  root.style.colorScheme = theme.mode;
  for (const [token, value] of Object.entries(theme.tokens)) {
    if (token.startsWith("--la-")) root.style.setProperty(token, value);
  }
}

function isTheme(value: unknown): value is PageTheme {
  const theme = value as PageTheme | null;
  return Boolean(theme && (theme.mode === "light" || theme.mode === "dark") && theme.tokens && typeof theme.tokens === "object");
}

type Listener = (...args: unknown[]) => void;

function notify(listeners: Iterable<Listener>, ...args: unknown[]): void {
  for (const listener of listeners) {
    try {
      listener(...args);
    } catch {
      // One page listener that throws does not stop the others.
    }
  }
}

function listenerOf(value: unknown): Listener {
  if (typeof value !== "function") throw { code: "invalid_input", message: "This takes a function." };
  return value as Listener;
}

// Watches run in main: it runs the read now and again after each change in
// the room, and pushes each answer here. The page keeps only its callback,
// called as callback(value, null) or callback(null, error).
const watches = new Map<string, Listener>();
let nextWatch = 0;

function watch(method: string, input: unknown, callback: unknown): () => void {
  const listener = listenerOf(callback);
  const id = `w${++nextWatch}`;
  watches.set(id, listener);
  call("events.watch", { id, method, input: input ?? null }).catch((error) => {
    if (watches.delete(id)) notify([listener], null, error);
  });
  return () => {
    if (watches.delete(id)) void call("events.unwatch", { id }).catch(() => undefined);
  };
}

const changeListeners = new Set<Listener>();

ipcRenderer.on(CHANNEL, (_event, message: { event?: unknown; value?: unknown; id?: unknown; error?: unknown; resource?: unknown }) => {
  if (message?.event === "watch") {
    const listener = typeof message.id === "string" ? watches.get(message.id) : undefined;
    if (listener) notify([listener], message.error ? null : message.value, message.error ?? null);
    return;
  }
  if (message?.event === "changed" || message?.event === "reread") {
    notify(changeListeners, message.event === "changed" ? { resource: message.resource } : { resource: "*" });
    return;
  }
  if (message?.event !== "theme" || !isTheme(message.value)) return;
  const theme = message.value;
  applyTheme(theme);
  notify(themeListeners as Set<Listener>, { mode: theme.mode, tokens: { ...theme.tokens } });
});

/** Each area's methods by the names a page uses, and the contract method each one calls. */
const AREAS: Record<string, Record<string, string>> = {
  rooms: { get: "rooms.get" },
  people: { list: "people.list", viewer: "people.viewer" },
  agents: { list: "agents.list" },
  messages: { recent: "messages.recent", thread: "messages.thread" },
  board: { tasks: "tasks.list", get: "tasks.get", planning: "planning.get" },
  work_items: { search: "work_items.search", get: "work_items.get", history: "work_items.history" },
  git: { pullRequests: "git.pullRequests" },
  memory: { list: "memory.list" },
  jobs: { start: "jobs.start", get: "jobs.get", list: "jobs.list", cancel: "jobs.cancel" },
  intents: { propose: "intents.propose", get: "intents.get", list: "intents.list" },
};
/** The watch each area offers: its name, and the read it keeps running. */
const AREA_WATCHES: Record<string, [string, string]> = {
  work_items: ["watch", "work_items.search"],
  board: ["onChange", "tasks.list"],
  jobs: ["onChange", "jobs.list"],
  intents: ["onChange", "intents.list"],
};

/** `use("data").collection(scope, name)`: one collection of shared documents in the viewer, page or room scope. */
function collection(scope: unknown, collectionName: unknown) {
  const where = { scope: name(scope, "The scope"), collection: name(collectionName, "The collection") };
  return {
    list: (input?: unknown) => call("data.list", { ...(input as object), ...where }),
    get: (docId: unknown) => call("data.get", { ...where, docId }),
    set: (docId: unknown, data: unknown, options?: unknown) => call("data.set", { ...(options as object), ...where, docId, data }),
    update: (docId: unknown, data: unknown, options?: unknown) => call("data.update", { ...(options as object), ...where, docId, data }),
    delete: (docId: unknown, options?: unknown) => call("data.delete", { ...(options as object), ...where, docId }),
    onSnapshot: (callback: unknown, input?: unknown) => watch("data.list", { ...(input as object), ...where }, callback),
  };
}

function area(areaName: string) {
  const methods: Record<string, unknown> = {
    /** Any method of the area by its contract name: `use("tasks").call("list", input)`. */
    call: (method: unknown, input?: unknown) => call(`${areaName}.${name(method, "The method")}`, input),
  };
  if (areaName === "data") methods.collection = collection;
  for (const [local, method] of Object.entries(AREAS[areaName] ?? {})) methods[local] = (input?: unknown) => call(method, input);
  const areaWatch = AREA_WATCHES[areaName];
  if (areaWatch) {
    const [local, method] = areaWatch;
    methods[local] = local === "watch"
      ? (input: unknown, callback: unknown) => watch(method, input, callback)
      : (callback: unknown, input?: unknown) => watch(method, input, callback);
  }
  return methods;
}

void call("ui.theme").then((theme) => { if (isTheme(theme)) applyTheme(theme); }, () => undefined);

contextBridge.exposeInMainWorld("letagents", {
  api: {
    /** The contract version the bridge speaks. */
    version: 1,
    /** Any contract method by its full name, such as `rooms.get`. */
    call: (method: unknown, input?: unknown) => call(name(method, "The method"), input),
  },
  page: { get: () => call("page.get") },
  viewer: { get: () => call("viewer.get") },
  /** One area of the contract, such as `use("work_items").search({ query })` or `use("data").collection("page", "notes")`. */
  use: (areaName: unknown) => area(name(areaName, "The area")),
  /** Any read kept running: `watch("tasks.list", input, (value, error) => …)`. */
  watch: (method: unknown, input: unknown, callback: unknown) => watch(name(method, "The method"), input, callback),
  events: {
    /** A pointer that something changed in the room (`{ resource }`), or `{ resource: "*" }` after a gap. */
    onChange: (callback: unknown) => {
      const listener = listenerOf(callback);
      changeListeners.add(listener);
      return () => { changeListeners.delete(listener); };
    },
  },
  ui: {
    open: (url: unknown) => call("ui.open", { url }),
    copy: (text: unknown) => call("ui.copy", { text }),
    theme: {
      get: () => call("ui.theme"),
      onChange: (listener: unknown) => {
        const callback = listenerOf(listener) as (theme: PageTheme) => void;
        themeListeners.add(callback);
        return () => { themeListeners.delete(callback); };
      },
    },
    context: () => call("ui.context"),
  },
});
