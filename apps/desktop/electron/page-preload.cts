// The preload of a room page, and nothing else: main sets it only on a page
// lease's webview. It runs sandboxed, so it must be CommonJS (tsc writes this
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

ipcRenderer.on(CHANNEL, (_event, message: { event?: unknown; value?: unknown }) => {
  if (message?.event !== "theme" || !isTheme(message.value)) return;
  const theme = message.value;
  applyTheme(theme);
  for (const listener of themeListeners) {
    try {
      listener({ mode: theme.mode, tokens: { ...theme.tokens } });
    } catch {
      // One page listener that throws does not stop the others.
    }
  }
});

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
  /** One area of the contract: `letagents.use("tasks").call("list", input)`. */
  use: (area: unknown) => {
    const prefix = name(area, "The area");
    return { call: (method: unknown, input?: unknown) => call(`${prefix}.${name(method, "The method")}`, input) };
  },
  ui: {
    open: (url: unknown) => call("ui.open", { url }),
    copy: (text: unknown) => call("ui.copy", { text }),
    theme: {
      get: () => call("ui.theme"),
      onChange: (listener: unknown) => {
        if (typeof listener !== "function") throw { code: "not_found", message: "onChange takes a function." };
        const callback = listener as (theme: PageTheme) => void;
        themeListeners.add(callback);
        return () => { themeListeners.delete(callback); };
      },
    },
    context: () => call("ui.context"),
  },
});
