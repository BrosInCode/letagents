/**
 * Runs in its own worker thread, with a memory cap and a deadline set by
 * `extract.ts`: reads the text of one PDF with Mozilla pdf.js and posts it
 * back. The PDF is untrusted, so nothing here evaluates its scripts, loads
 * fonts or reaches the network.
 */
import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";

interface PdfTextWorkerInput {
  bytes: Uint8Array;
  pdfjsPath: string;
  cMapDir: string;
  maxPages: number;
  maxChars: number;
}

interface PdfjsTextItem { str?: unknown; hasEOL?: unknown }

const input = workerData as PdfTextWorkerInput;

async function run(): Promise<void> {
  const pdfjs = await import(pathToFileURL(input.pdfjsPath).href) as {
    getDocument: (options: Record<string, unknown>) => { promise: Promise<PdfjsDocument>; destroy: () => Promise<void> };
  };
  const task = pdfjs.getDocument({
    data: input.bytes,
    // A PDF's own JavaScript and fonts never run; text extraction needs neither.
    isEvalSupported: false,
    enableXfa: false,
    disableFontFace: true,
    useSystemFonts: false,
    isOffscreenCanvasSupported: false,
    // Character maps turn CJK and other encoded text into Unicode.
    cMapUrl: input.cMapDir,
    cMapPacked: true,
    verbosity: 0,
  });
  try {
    const document = await task.promise;
    const pages: string[] = [];
    let chars = 0;
    let truncated = false;
    const last = Math.min(document.numPages, input.maxPages);
    for (let number = 1; number <= last; number += 1) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items as PdfjsTextItem[]) {
        if (typeof item.str === "string") text += item.str;
        if (item.hasEOL === true) text += "\n";
      }
      page.cleanup();
      text = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
      if (chars + text.length > input.maxChars) {
        pages.push(text.slice(0, Math.max(0, input.maxChars - chars)));
        truncated = true;
        break;
      }
      pages.push(text);
      chars += text.length;
    }
    if (document.numPages > input.maxPages) truncated = true;
    parentPort!.postMessage({ ok: true, pageCount: document.numPages, pages, truncated });
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

interface PdfjsDocument {
  numPages: number;
  getPage(number: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }>; cleanup(): void }>;
}

run().catch((error: unknown) => {
  const name = error && typeof error === "object" && "name" in error ? String((error as { name: unknown }).name) : "";
  parentPort!.postMessage({ ok: false, reason: name === "PasswordException" ? "encrypted" : "invalid" });
});
