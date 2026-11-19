import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

/**
 * Reading the text of PDF attachments on the server, so every agent kind gets
 * it without installing a PDF library (the npm package stays small). Mozilla
 * pdf.js is a server-only dependency in this folder's own package.json; the
 * server image installs it without its optional native canvas.
 *
 * A PDF is untrusted input, so each one is read in its own worker thread with
 * a memory cap and a deadline, few at a time, and the text is kept for a while
 * because attachments never change.
 */
export const PDF_TEXT_LIMITS = Object.freeze({
  /** Attachments are at most 25 MB; a larger PDF is not read. */
  maxBytes: 25 * 1024 * 1024,
  /** Pages read from one PDF; the rest are left out and the answer says so. */
  maxPages: 1_000,
  /** Characters kept from one PDF. */
  maxChars: 2_000_000,
  /** One PDF gets this long, then its worker is stopped. */
  timeoutMs: 20_000,
  /** The worker's heap; a PDF that needs more is refused. */
  memoryMb: 256,
  /** PDFs read at once in this process. */
  concurrent: 2,
  /** Texts kept, by attachment, and for how long. */
  cacheEntries: 16,
  cacheChars: 8_000_000,
  cacheMs: 30 * 60_000,
});

export type PdfTextFailure = "encrypted" | "invalid" | "too_complex" | "busy" | "unavailable";

export class PdfTextError extends Error {
  constructor(readonly reason: PdfTextFailure) {
    super(`The PDF could not be read (${reason}).`);
    this.name = "PdfTextError";
  }
}

export interface PdfText {
  pageCount: number;
  /** The text of pages 1 to `pages.length`, in order. */
  pages: string[];
  /** Pages or characters past the limits were left out. */
  truncated: boolean;
}

const here = dirname(fileURLToPath(import.meta.url));

/** Where pdf.js is installed: an override, the server image's folder, or this source folder. */
function pdfjsLocation(): { pdfjsPath: string; cMapDir: string } | null {
  const candidates = [
    process.env.LETAGENTS_PDF_TEXT_DEPS,
    here,
    // dist/api/pdf-text in a checkout reads the source folder's install.
    join(here, "..", "..", "..", "src", "api", "pdf-text"),
    // The server image installs it in /app/pdf-text.
    join(here, "..", "..", "..", "pdf-text"),
  ];
  for (const folder of candidates) {
    if (!folder) continue;
    try {
      const require = createRequire(join(folder, "package.json"));
      const pdfjsPath = require.resolve("pdfjs-dist/legacy/build/pdf.mjs");
      const cMapDir = join(dirname(require.resolve("pdfjs-dist/package.json")), "cmaps") + "/";
      return { pdfjsPath, cMapDir };
    } catch {
      // Not installed there.
    }
  }
  return null;
}

/**
 * The compiled worker next to this file, started with none of the server's own
 * Node flags; or, when the code runs from source, the source worker with them
 * (they hold the TypeScript loader).
 */
function workerFile(): { url: URL; execArgv?: string[] } {
  const compiled = new URL("./worker.js", import.meta.url);
  return existsSync(fileURLToPath(compiled)) ? { url: compiled, execArgv: [] } : { url: new URL("./worker.ts", import.meta.url) };
}

export function isPdfTextAvailable(): boolean {
  return pdfjsLocation() !== null;
}

let running = 0;
const inFlight = new Map<string, Promise<PdfText>>();
const cache = new Map<string, { text: PdfText; chars: number; at: number }>();

function cached(key: string, now: number): PdfText | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (now - entry.at > PDF_TEXT_LIMITS.cacheMs) {
    cache.delete(key);
    return null;
  }
  // Most recently used last, so the oldest goes first.
  cache.delete(key);
  cache.set(key, entry);
  return entry.text;
}

function remember(key: string, text: PdfText, now: number): void {
  const chars = text.pages.reduce((sum, page) => sum + page.length, 0);
  if (chars > PDF_TEXT_LIMITS.cacheChars) return;
  cache.delete(key);
  cache.set(key, { text, chars, at: now });
  let total = 0;
  for (const entry of cache.values()) total += entry.chars;
  for (const [oldest, entry] of cache) {
    if (cache.size <= PDF_TEXT_LIMITS.cacheEntries && total <= PDF_TEXT_LIMITS.cacheChars) break;
    cache.delete(oldest);
    total -= entry.chars;
  }
}

/** Drop every kept text (tests). */
export function clearPdfTextCache(): void {
  cache.clear();
}

/**
 * The text of the PDF that `key` names (an attachment's storage key: the
 * bytes behind it never change). `load` gives its bytes and runs only when
 * the text is not kept and no other call is reading the same PDF.
 */
export async function pdfTextFor(key: string, load: () => Promise<Uint8Array>, now = Date.now()): Promise<PdfText> {
  const kept = cached(key, now);
  if (kept) return kept;
  const pending = inFlight.get(key);
  if (pending) return pending;
  if (running >= PDF_TEXT_LIMITS.concurrent) throw new PdfTextError("busy");
  running += 1;
  const reading = (async () => {
    try {
      const text = await extractPdfText(await load());
      remember(key, text, Date.now());
      return text;
    } finally {
      running -= 1;
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, reading);
  return reading;
}

/** Read the text of one PDF in a fresh worker thread with the limits above. */
export function extractPdfText(bytes: Uint8Array, limits: Partial<typeof PDF_TEXT_LIMITS> = {}): Promise<PdfText> {
  const options = { ...PDF_TEXT_LIMITS, ...limits };
  const location = pdfjsLocation();
  if (!location) return Promise.reject(new PdfTextError("unavailable"));
  if (bytes.byteLength > options.maxBytes) return Promise.reject(new PdfTextError("too_complex"));
  return new Promise<PdfText>((resolve, reject) => {
    const file = workerFile();
    const worker = new Worker(file.url, {
      ...(file.execArgv ? { execArgv: file.execArgv } : {}),
      workerData: { bytes, ...location, maxPages: options.maxPages, maxChars: options.maxChars },
      resourceLimits: { maxOldGenerationSizeMb: options.memoryMb, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
      stdout: true,
      stderr: true,
    });
    // The worker's own console (pdf.js warnings) is not the server's log.
    worker.stdout.resume();
    worker.stderr.resume();
    let settled = false;
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      void worker.terminate().catch(() => undefined);
      outcome();
    };
    const deadline = setTimeout(() => finish(() => reject(new PdfTextError("too_complex"))), options.timeoutMs);
    worker.once("message", (message: unknown) => finish(() => {
      const answer = message as { ok?: boolean; reason?: PdfTextFailure; pageCount?: unknown; pages?: unknown; truncated?: unknown };
      if (answer?.ok === true && typeof answer.pageCount === "number" && Array.isArray(answer.pages)
        && answer.pages.every((page) => typeof page === "string")) {
        resolve({ pageCount: answer.pageCount, pages: answer.pages as string[], truncated: answer.truncated === true });
      } else {
        reject(new PdfTextError(answer?.reason === "encrypted" ? "encrypted" : "invalid"));
      }
    }));
    // Out of memory, or a crash inside pdf.js.
    worker.once("error", (error: Error & { code?: string }) => finish(() => reject(new PdfTextError(
      error?.code === "ERR_WORKER_OUT_OF_MEMORY" ? "too_complex" : "invalid",
    ))));
    worker.once("exit", () => finish(() => reject(new PdfTextError("invalid"))));
  });
}
