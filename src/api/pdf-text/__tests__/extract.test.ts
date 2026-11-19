import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { clearPdfTextCache, extractPdfText, PDF_TEXT_LIMITS, PdfTextError, pdfTextFor } from "../extract.js";
import { makePdf } from "./make-pdf.js";

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
    await pdfTextFor("bucket/one", load, Date.now() + PDF_TEXT_LIMITS.cacheMs + 1);
    assert.equal(loads, 2);

    // Only PDF_TEXT_LIMITS.concurrent different PDFs are read at once.
    const gates: Array<() => void> = [];
    const slow = () => new Promise<Uint8Array>((resolve) => gates.push(() => resolve(pdf)));
    const running = Array.from({ length: PDF_TEXT_LIMITS.concurrent }, (_, index) => pdfTextFor(`bucket/slow-${index}`, slow));
    await assert.rejects(pdfTextFor("bucket/other", load), (error) => reason(error) === "busy");
    for (const open of gates) open();
    await Promise.all(running);
    await pdfTextFor("bucket/other", load);
  });

  it("does not keep a failure", async () => {
    let loads = 0;
    const broken = async () => { loads += 1; return new TextEncoder().encode("%PDF-1.7 broken"); };
    await assert.rejects(pdfTextFor("bucket/broken", broken));
    await assert.rejects(pdfTextFor("bucket/broken", broken));
    assert.equal(loads, 2);
  });
});
