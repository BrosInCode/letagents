import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { Worker } from "node:worker_threads";

import { clearPdfTextCache, extractPdfText, isPdfTextAvailable, PDF_TEXT_LIMITS, PdfTextError, pdfTextFor } from "../extract.js";
import { makeInflatingPdf, makeNestedFormsPdf, makePdf } from "./make-pdf.js";

const reason = (error: unknown) => error instanceof PdfTextError ? error.reason : String(error);

describe("PDF text extraction (pdf.js in a worker thread)", () => {
  afterEach(() => clearPdfTextCache());

  it("reads each page's text in order, with its line breaks", async () => {
    const text = await extractPdfText(makePdf(["Invoice 2026-11\nTotal: 420 EUR", "Terms (net 30)", ""]));
    assert.deepEqual(text, { pageCount: 3, pages: ["Invoice 2026-11\nTotal: 420 EUR", "Terms (net 30)", ""], truncated: false });
  });

  it("names a PDF that needs a password, and bytes that are not a PDF", async () => {
    await assert.rejects(extractPdfText(makePdf(["secret"], { encrypted: true })), (error) => reason(error) === "encrypted");
    await assert.rejects(extractPdfText(new TextEncoder().encode("%PDF-1.7\nnot really a pdf")), (error) => reason(error) === "invalid");
    await assert.rejects(extractPdfText(new Uint8Array()), (error) => reason(error) === "invalid");
  });

  it("stops a PDF that takes too long, and one larger than the limit", async () => {
    await assert.rejects(extractPdfText(makePdf(["slow"]), { timeoutMs: 1 }), (error) => reason(error) === "too_complex");
    await assert.rejects(extractPdfText(makePdf(["big"]), { maxBytes: 10 }), (error) => reason(error) === "too_complex");
  });

  it("stops a running worker at its deadline: a few KB of nested forms that would draw 10^8 times", async () => {
    const pdf = makeNestedFormsPdf(9, 10);
    assert.ok(pdf.byteLength < 4096, `${pdf.byteLength} bytes`);
    const started = Date.now();
    await assert.rejects(extractPdfText(pdf, { timeoutMs: 1_000 }), (error) => reason(error) === "too_complex");
    assert.ok(Date.now() - started < 5_000, `stopped after ${Date.now() - started} ms`);
  });

  it("stops a PDF whose streams inflate past the memory outside the heap", async () => {
    const pdf = makeInflatingPdf(256);
    assert.ok(pdf.byteLength < 1024 * 1024, `${pdf.byteLength} bytes`);
    const started = Date.now();
    await assert.rejects(extractPdfText(pdf, { externalMemoryMb: 64 }), (error) => reason(error) === "too_complex");
    assert.ok(Date.now() - started < 10_000, `stopped after ${Date.now() - started} ms`);
  });

  it("reads no PDF on a Node that cannot measure a worker's memory", async () => {
    const prototype = Worker.prototype as { getHeapStatistics?: unknown };
    const original = prototype.getHeapStatistics;
    assert.equal(isPdfTextAvailable(), true);
    delete prototype.getHeapStatistics;
    try {
      assert.equal(isPdfTextAvailable(), false);
      await assert.rejects(extractPdfText(makePdf(["x"])), (error) => reason(error) === "unavailable");
    } finally {
      prototype.getHeapStatistics = original;
    }
  });

  it("reads only so many pages and characters, and says so", async () => {
    const pages = Array.from({ length: 5 }, (_, index) => `page ${index + 1} ${"z".repeat(20)}`);
    assert.deepEqual(await extractPdfText(makePdf(pages), { maxPages: 2 }), { pageCount: 5, pages: pages.slice(0, 2), truncated: true });
    const short = await extractPdfText(makePdf(pages), { maxChars: 40 });
    assert.equal(short.truncated, true);
    assert.equal(short.pages.join("").length, 40);
  });

  it("keeps the text by attachment, reads one PDF once at a time, and refuses past the limit", async () => {
    let loads = 0;
    const pdf = makePdf(["kept"]);
    const load = async () => { loads += 1; return pdf; };
    const [a, b] = await Promise.all([pdfTextFor("bucket/one", load), pdfTextFor("bucket/one", load)]);
    assert.equal(loads, 1, "two calls for the same PDF share one read");
    assert.equal(a, b);
    await pdfTextFor("bucket/one", load);
    assert.equal(loads, 1, "a kept text is not read again");
    // Past the time it is kept, it is read again.
    await pdfTextFor("bucket/one", load, { now: Date.now() + PDF_TEXT_LIMITS.cacheMs + 1 });
    assert.equal(loads, 2);

    // Only PDF_TEXT_LIMITS.concurrent different PDFs are read at once, and one per requester.
    const gates: Array<() => void> = [];
    const slow = () => new Promise<Uint8Array>((resolve) => gates.push(() => resolve(pdf)));
    const first = pdfTextFor("bucket/slow-0", slow, { requester: "acct_a" });
    await assert.rejects(pdfTextFor("bucket/slow-1", slow, { requester: "acct_a" }), (error) => reason(error) === "busy", "one account, one PDF at a time");
    const second = pdfTextFor("bucket/slow-1", slow, { requester: "acct_b" });
    await assert.rejects(pdfTextFor("bucket/other", load, { requester: "acct_c" }), (error) => reason(error) === "busy", "every slot is taken");
    for (const open of gates) open();
    await Promise.all([first, second]);
    await pdfTextFor("bucket/other", load, { requester: "acct_a" });
  });

  it("remembers a PDF that cannot be read, so it does not take a slot again at once", async () => {
    let loads = 0;
    const broken = async () => { loads += 1; return new TextEncoder().encode("%PDF-1.7 broken"); };
    await assert.rejects(pdfTextFor("bucket/broken", broken), (error) => reason(error) === "invalid");
    await assert.rejects(pdfTextFor("bucket/broken", broken), (error) => reason(error) === "invalid");
    assert.equal(loads, 1);
    await assert.rejects(pdfTextFor("bucket/broken", broken, { now: Date.now() + PDF_TEXT_LIMITS.failureCacheMs + 1 }));
    assert.equal(loads, 2, "after a while it is tried again");
    // Out of time, which a busy server can cause, is marked so it is remembered for less.
    await assert.rejects(extractPdfText(makeNestedFormsPdf(9, 10), { timeoutMs: 1 }), (error) => error instanceof PdfTextError && error.timedOut);
    assert.ok(PDF_TEXT_LIMITS.timeoutCacheMs < PDF_TEXT_LIMITS.failureCacheMs);
    // A storage failure says nothing about the PDF, so it is not remembered.
    let fetches = 0;
    const storageDown = async (): Promise<Uint8Array> => { fetches += 1; throw new Error("storage down"); };
    await assert.rejects(pdfTextFor("bucket/flaky", storageDown));
    await assert.rejects(pdfTextFor("bucket/flaky", storageDown));
    assert.equal(fetches, 2);
    // A loader that throws before it awaits anything leaves nothing behind.
    let syncLoads = 0;
    const throwsAtOnce = (): Promise<Uint8Array> => { syncLoads += 1; throw new Error("bad key"); };
    await assert.rejects(pdfTextFor("bucket/sync", throwsAtOnce));
    await assert.rejects(pdfTextFor("bucket/sync", throwsAtOnce));
    assert.equal(syncLoads, 2, "the second call runs its own loader");
  });
});
