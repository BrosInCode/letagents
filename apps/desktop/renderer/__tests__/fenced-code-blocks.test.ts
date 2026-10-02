import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderDesktopMarkdown } from "../src/components/desktop/content/formatting/markdown";
import { renderMessageText } from "../src/components/desktop/content/desktop-chat-message/message-rendering";
import { desktopHighlighter } from "../src/components/desktop/content/formatting/code-highlighter";
import {
  MAX_HIGHLIGHT_CHARS,
  MAX_HIGHLIGHT_LINES,
  MAX_HIGHLIGHT_LINE_LENGTH,
  CodeHighlightCache,
  createCodeHighlighter,
  executeCodeBlockCopy,
  setupCodeBlockCopyListener,
  resolveLanguage,
} from "../../../../shared/code-highlighting.mjs";

function createMockButton(isConnected = true) {
  const attrs = new Map();
  return {
    isConnected,
    setAttribute(name: string, val: string) {
      attrs.set(name, String(val));
    },
    removeAttribute(name: string) {
      attrs.delete(name);
    },
    getAttribute(name: string) {
      return attrs.get(name) ?? null;
    },
  } as unknown as HTMLButtonElement;
}

describe("Fenced Code Blocks & Syntax Highlighting (Desktop)", () => {
  it("renders code block with header, language badge, and copy button", () => {
    const input = ["```python", "def hello():", '    return "world"', "```"].join("\n");
    const html = renderDesktopMarkdown(input, { block: true });

    assert.match(html, /<div class="fenced-code-block">/);
    assert.match(html, /<div class="fenced-code-block-header">/);
    assert.match(html, /<span class="fenced-code-block-lang" data-lang="python"><\/span>/);
    assert.match(
      html,
      /<button type="button" class="fenced-code-block-copy" data-code-copy aria-label="Copy code"><\/button>/,
    );
    assert.match(html, /<pre><code class="fenced-code-block-content language-python">/);
    assert.match(html, /<span class="hljs-keyword">def<\/span>/);
    assert.match(html, /<span class="hljs-string">&quot;world&quot;<\/span>/);
  });

  it("header elements contain zero text nodes to prevent selection and search hits pollution", () => {
    const input = ["```javascript", "const x = 42;", "```"].join("\n");
    const html = renderDesktopMarkdown(input, { block: true });

    const headerMatch = /<div class="fenced-code-block-header">(.*?)<\/div>/.exec(html);
    assert.ok(headerMatch, "header should exist");
    const headerInner = headerMatch[1];

    // Verify span and button are empty tags with no text nodes inside
    assert.match(headerInner, /<span class="fenced-code-block-lang" data-lang="javascript"><\/span>/);
    assert.match(headerInner, /<button type="button" class="fenced-code-block-copy" data-code-copy aria-label="Copy code"><\/button>/);

    // Stripping all tags from the header should leave zero characters
    const textOnly = headerInner.replace(/<[^>]+>/g, "").trim();
    assert.equal(textOnly, "", "header must have zero text nodes");
  });

  it("renders alias language tags with matched key as label (e.g. html, not xml)", () => {
    const input = ["```html", "<div>Hello</div>", "```"].join("\n");
    const html = renderDesktopMarkdown(input, { block: true });

    assert.match(html, /data-lang="html"/);
    assert.match(html, /class="fenced-code-block-content language-html"/);
    // Uses xml highlighter under the hood
    assert.match(html, /<span class="hljs-tag">&lt;<span class="hljs-name">div<\/span>&gt;<\/span>/);
  });

  it("unlabelled fences omit the label span and language class, and remain plain escaped text", () => {
    const input = ["```", "plain text 123", "```"].join("\n");
    const html = renderDesktopMarkdown(input, { block: true });

    assert.match(html, /<div class="fenced-code-block">/);
    assert.match(html, /<button type="button" class="fenced-code-block-copy" data-code-copy aria-label="Copy code"><\/button>/);
    // Label span MUST be omitted per spec
    assert.doesNotMatch(html, /class="fenced-code-block-lang"/);
    assert.doesNotMatch(html, /data-lang/);
    assert.match(html, /<code class="fenced-code-block-content">plain text 123<\/code>/);
    assert.doesNotMatch(html, /language-/);
  });

  it("unknown language tags omit the label span and language class, without auto-detection", () => {
    const input = ["```unknownlang123", "function test() { return 1; }", "```"].join("\n");
    const html = renderDesktopMarkdown(input, { block: true });

    assert.match(html, /<div class="fenced-code-block">/);
    assert.doesNotMatch(html, /class="fenced-code-block-lang"/);
    assert.doesNotMatch(html, /data-lang/);
    assert.match(html, /<code class="fenced-code-block-content">function test\(\) \{ return 1; \}<\/code>/);
    assert.doesNotMatch(html, /language-/);
    assert.doesNotMatch(html, /hljs-/);
  });

  it("prototype properties do not resolve as languages", () => {
    for (const prop of ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty"]) {
      assert.equal(resolveLanguage(prop), null, `${prop} must not resolve as a language`);

      const input = ["```" + prop, "const a = 1;", "```"].join("\n");
      const html = renderDesktopMarkdown(input, { block: true });
      assert.match(html, /<div class="fenced-code-block">/);
      assert.doesNotMatch(html, /class="fenced-code-block-lang"/);
      assert.doesNotMatch(html, /data-lang/);
      assert.doesNotMatch(html, /hljs-/);
    }
  });

  it("safely escapes hostile input and prevents XSS", () => {
    const hostileCode = '</code></pre><script>alert(1)</script><img src=x onerror=alert(2)>';
    const input = ["```javascript", hostileCode, "```"].join("\n");
    const html = renderDesktopMarkdown(input, { block: true });

    assert.doesNotMatch(html, /<script[\s>]/);
    assert.doesNotMatch(html, /<img[\s>]/);
    assert.doesNotMatch(html, /onerror=/i);
    assert.match(html, /&lt;.*?script.*?alert\(1\)/);
  });

  it('renders malformed fence tag with quotes or handlers as ordinary escaped text', () => {
    const input = '```js" onclick="alert(1)\nconsole.log(1)';
    const html = renderDesktopMarkdown(input, { block: true });

    // Must NOT match fence regex or produce a code block
    assert.doesNotMatch(html, /<div class="fenced-code-block">/);
    assert.doesNotMatch(html, /<button/);
    assert.doesNotMatch(html, /<[a-z0-9]+[^>]*onclick=/i);
    assert.match(html, /&quot; onclick=&quot;alert\(1\)/);
  });

  it("renders fenced code blocks correctly inside blockquotes", () => {
    const input = [
      "> Quoted text",
      "> ```python",
      "> print('inside blockquote')",
      "> ```",
    ].join("\n");
    const html = renderDesktopMarkdown(input, { block: true });

    assert.match(html, /<blockquote>/);
    assert.match(html, /<div class="fenced-code-block">/);
    assert.match(html, /data-lang="python"/);
    assert.match(html, /<span class="hljs-built_in">print<\/span>\(/);
  });

  it("diff blocks highlight additions, deletions, and meta hunk headers", () => {
    const input = [
      "```diff",
      "@@ -1,2 +1,2 @@",
      "-old line",
      "+new line",
      "```",
    ].join("\n");
    const html = renderDesktopMarkdown(input, { block: true });

    assert.match(html, /<span class="hljs-meta">@@ -1,2 \+1,2 @@<\/span>/);
    assert.match(html, /<span class="hljs-deletion">-old line<\/span>/);
    assert.match(html, /<span class="hljs-addition">\+new line<\/span>/);
  });

  it("markdown/md language tag is dropped and renders as plain unhighlighted text", () => {
    for (const tag of ["markdown", "md"]) {
      assert.equal(resolveLanguage(tag), null);
      const input = ["```" + tag, "# Heading", "[link](url)", "```"].join("\n");
      const html = renderDesktopMarkdown(input, { block: true });

      assert.match(html, /<div class="fenced-code-block">/);
      assert.doesNotMatch(html, /class="fenced-code-block-lang"/);
      assert.doesNotMatch(html, /data-lang/);
      assert.doesNotMatch(html, /class="hljs-/);
      assert.match(html, /<code class="fenced-code-block-content"># Heading\n\[link\]\(url\)<\/code>/);
    }
  });

  it("search-hit highlighting skips code blocks and does not inject marks into header or code", () => {
    const message = [
      "Here is python code:",
      "```python",
      "def python_helper():",
      '    return "python"',
      "```",
      "End of python snippet.",
    ].join("\n");

    const html = renderMessageText(message, "python");

    // Outside code block, "python" query is marked
    assert.match(html, /Here is <mark class="message-search-hit">python<\/mark> code:/);
    assert.match(html, /End of <mark class="message-search-hit">python<\/mark> snippet\./);

    // Inside header and code block, NO marks injected
    const codeBlockMatch = /<div class="fenced-code-block">[\s\S]*?<\/div>/.exec(html);
    assert.ok(codeBlockMatch, "code block exists");
    assert.doesNotMatch(codeBlockMatch[0], /<mark/);
  });

  it("skips syntax highlighting when character count exceeds MAX_HIGHLIGHT_CHARS", () => {
    const hugeCode = "const a = 1;\n".repeat(450); // > 5,800 chars
    assert.ok(hugeCode.length > MAX_HIGHLIGHT_CHARS);

    const result = desktopHighlighter.renderCodeBlock(hugeCode, "javascript");
    assert.match(result, /<div class="fenced-code-block">/);
    assert.match(result, /data-lang="javascript"/);
    // Should NOT contain syntax highlighting spans
    assert.doesNotMatch(result, /class="hljs-/);
  });

  it("skips syntax highlighting at exact line count boundaries (250 vs 251 lines)", () => {
    // Exactly 250 lines -> highlighted
    const exact250Lines = Array.from({ length: 250 }, (_, i) => `x = ${i}`).join("\n");
    assert.equal(exact250Lines.split("\n").length, 250);
    const result250 = desktopHighlighter.renderCodeBlock(exact250Lines, "python");
    assert.match(result250, /class="hljs-/);

    // 251 lines -> exceeds limit, plain text
    const lines251 = Array.from({ length: 251 }, (_, i) => `x = ${i}`).join("\n");
    assert.equal(lines251.split("\n").length, 251);
    const result251 = desktopHighlighter.renderCodeBlock(lines251, "python");
    assert.doesNotMatch(result251, /class="hljs-/);
  });

  it("skips syntax highlighting when any single line exceeds MAX_HIGHLIGHT_LINE_LENGTH", () => {
    // 1001 chars on one line
    const longLine = "const a = " + "x".repeat(MAX_HIGHLIGHT_LINE_LENGTH);
    assert.ok(longLine.length > MAX_HIGHLIGHT_LINE_LENGTH);

    const result = desktopHighlighter.renderCodeBlock(longLine, "javascript");
    assert.match(result, /<div class="fenced-code-block">/);
    assert.doesNotMatch(result, /class="hljs-/);
  });

  it("sliding time budget: bounds computation to max budget per window, falls back uncached", () => {
    let fakeTime = 1000;
    let highlightCalls = 0;

    const budgetedHighlighter = createCodeHighlighter({
      highlight(code, lang) {
        highlightCalls++;
        fakeTime += 60; // each call takes 60ms of fake time
        return `<span class="hljs-keyword">${code}</span>`;
      },
      now: () => fakeTime,
      maxBudgetMs: 100, // 100ms budget per 1000ms window
      windowMs: 1000,
    });

    // 1. First block: 0ms spent -> highlights, costs 60ms (spent = 60ms <= 100ms)
    const block1 = budgetedHighlighter.renderCodeBlock("const a = 1;", "javascript");
    assert.match(block1, /class="hljs-keyword"/);
    assert.equal(highlightCalls, 1);

    // 2. Second block: 60ms spent -> highlights, costs 60ms (spent = 120ms > 100ms)
    const block2 = budgetedHighlighter.renderCodeBlock("const b = 2;", "javascript");
    assert.match(block2, /class="hljs-keyword"/);
    assert.equal(highlightCalls, 2);

    // 3. Third block: 120ms spent >= 100ms budget -> budget exhausted!
    // Falls back to plain escaped text, highlight is NOT called, and result is NOT cached
    const block3 = budgetedHighlighter.renderCodeBlock("const c = 3;", "javascript");
    assert.doesNotMatch(block3, /class="hljs-keyword"/);
    assert.match(block3, /const c = 3;/);
    assert.equal(highlightCalls, 2, "highlight should not be called when budget is exhausted");
    assert.equal(budgetedHighlighter.cache.get("javascript:const c = 3;"), undefined, "fallback must not be cached");

    // 4. Cache hit test: re-rendering block1 returns cached highlighted HTML with zero time cost
    const block1Cached = budgetedHighlighter.renderCodeBlock("const a = 1;", "javascript");
    assert.match(block1Cached, /class="hljs-keyword"/);
    assert.equal(highlightCalls, 2, "cache hit should not invoke highlight or consume budget");

    // 5. Sliding window elapsed: advance time past 1000ms window
    fakeTime += 1001; // entries from timestamp 1000 and 1060 age out
    const block3AfterWindow = budgetedHighlighter.renderCodeBlock("const c = 3;", "javascript");
    assert.match(block3AfterWindow, /class="hljs-keyword"/);
    assert.equal(highlightCalls, 3, "should highlight again after window elapses");
    assert.ok(budgetedHighlighter.cache.get("javascript:const c = 3;") !== undefined, "successful highlight is now cached");
  });

  it("structural test: over hostile corpus every tag is in allowlist and whole attribute string matches exact allowlist", () => {
    const hostileCorpus = [
      '```javascript\n</code></pre><script>alert("xss")</script><img src=x onerror=alert(1)>\n```',
      '```html\n<div onmouseover="evil()" style="color:red"><iframe src="about:blank"></iframe></div>\n```',
      '```python\nimport os\nos.system("rm -rf /") # <b>test</b> & <script>\n```',
      '```diff\n@@ -1 +1 @@\n-<svg onload="alert(1)">\n+&lt;clean&gt;\n```',
      '```\nplain text with <style>body{display:none}</style> and &quot;\n```',
    ];

    const allowedTags = new Set(["div", "span", "button", "pre", "code"]);

    for (const input of hostileCorpus) {
      const html = renderDesktopMarkdown(input, { block: true });

      // Match all opening tags: <tag ...>
      const tagRegex = /<([a-zA-Z0-9]+)([^>]*)>/g;
      let match: RegExpExecArray | null;
      while ((match = tagRegex.exec(html)) !== null) {
        const tagName = match[1]!.toLowerCase();
        assert.ok(allowedTags.has(tagName), `Tag <${tagName}> must be in allowedTags`);

        const rawAttrs = match[2]!.trim();
        if (tagName === "span") {
          // Whole attribute string must match either syntax class or language badge
          const validSpan =
            /^class="[a-zA-Z0-9_-]+(?: [a-zA-Z0-9_-]+)*"$/.test(rawAttrs) ||
            /^class="fenced-code-block-lang" data-lang="[a-zA-Z0-9_+ -]+"$/.test(rawAttrs);
          assert.ok(validSpan, `Span attribute string "${rawAttrs}" violates allowlist`);
        } else if (tagName === "button") {
          const validButton =
            /^type="button" class="fenced-code-block-copy" data-code-copy aria-label="Copy code"$/.test(rawAttrs);
          assert.ok(validButton, `Button attribute string "${rawAttrs}" violates allowlist`);
        } else if (tagName === "div") {
          const validDiv =
            rawAttrs === 'class="fenced-code-block"' || rawAttrs === 'class="fenced-code-block-header"';
          assert.ok(validDiv, `Div attribute string "${rawAttrs}" violates allowlist`);
        } else if (tagName === "code") {
          const validCode =
            /^class="fenced-code-block-content(?: language-[a-zA-Z0-9_+ -]+)?"$/.test(rawAttrs);
          assert.ok(validCode, `Code attribute string "${rawAttrs}" violates allowlist`);
        } else if (tagName === "pre") {
          assert.equal(rawAttrs, "", `Pre tag must have no attributes, got "${rawAttrs}"`);
        }
      }
    }
  });

  it("adversarial corpus benchmark: all supported languages complete within bound (< 500 ms)", () => {
    const lineWrap = (str: string, len = 500) => {
      const lines = [];
      for (let i = 0; i < str.length; i += len) lines.push(str.slice(i, i + len));
      return lines.join("\n");
    };

    const cap = 4_500;
    const adversarialPatterns = [
      lineWrap('"' + "x".repeat(cap)),
      lineWrap("'" + "x".repeat(cap)),
      lineWrap("`" + "x".repeat(cap)),
      lineWrap("/*" + "x".repeat(cap)),
      lineWrap("<!--" + "x".repeat(cap)),
      lineWrap("<".repeat(cap)),
      lineWrap("(".repeat(cap)),
      lineWrap("{".repeat(cap)),
      lineWrap("[".repeat(cap)),
      lineWrap("/".repeat(cap)),
      lineWrap(":".repeat(cap)),
      lineWrap("a".repeat(cap)),
      lineWrap("a ".repeat(cap / 2)),
      lineWrap("a_".repeat(cap / 2)),
      lineWrap("function if else return const let var while for switch case ".repeat(cap / 60)),
    ];

    const supportedLangs = [
      "javascript", "typescript", "python", "bash", "json", "yaml", "xml", "css",
      "sql", "diff", "rust", "go", "c", "cpp", "java", "csharp", "dockerfile",
      "ruby", "php", "swift", "kotlin", "ini",
    ];

    for (const lang of supportedLangs) {
      for (const pattern of adversarialPatterns) {
        const t0 = performance.now();
        desktopHighlighter.renderCodeBlock(pattern, lang);
        const elapsed = performance.now() - t0;
        assert.ok(
          elapsed < 500,
          `Adversarial input for ${lang} took ${elapsed} ms, exceeding 500 ms limit`,
        );
      }
    }
  });

  it("dual-bounded LRU cache bounds entries and total character size (keys + values)", () => {
    const cache = new CodeHighlightCache(3, 100);

    // key length = 1, val length = 5 -> total chars = 6 per entry
    cache.set("a", "12345");
    cache.set("b", "67890");
    cache.set("c", "abcde");
    assert.equal(cache.size, 3);
    assert.equal(cache.totalChars, 18); // 3 * (1 + 5) = 18

    // Accessing "a" makes it most recently used
    assert.equal(cache.get("a"), "12345");

    // Adding "d" evicts the least recently used ("b")
    cache.set("d", "fghij");
    assert.equal(cache.size, 3);
    assert.equal(cache.get("b"), undefined);
    assert.equal(cache.get("a"), "12345");
    assert.equal(cache.get("c"), "abcde");
    assert.equal(cache.get("d"), "fghij");

    // Adding a huge item exceeding maxChars evicts until under limit
    const huge = "x".repeat(90);
    cache.set("huge", huge);
    assert.ok(cache.totalChars <= 100);
    assert.ok(cache.size <= 3);
  });

  it("executeCodeBlockCopy: handles success, failure, missing element, timer race, and detached button", async () => {
    // 1. Success state
    const btnSuccess = createMockButton(true);
    const timers = new WeakMap<HTMLButtonElement, number>();

    const resSuccess = await executeCodeBlockCopy(btnSuccess, "code sample", async () => true, timers);
    assert.equal(resSuccess.success, true);
    assert.equal(btnSuccess.getAttribute("data-copied"), "true");
    assert.equal(btnSuccess.getAttribute("aria-label"), "Copied to clipboard");
    assert.ok(resSuccess.timerId !== null);

    // 2. Failure state
    const btnFail = createMockButton(true);
    const resFail = await executeCodeBlockCopy(btnFail, "code sample", async () => { throw new Error("Clipboard denied"); }, timers);
    assert.equal(resFail.success, false);
    assert.equal(btnFail.getAttribute("data-copied"), "error");
    assert.equal(btnFail.getAttribute("aria-label"), "Failed to copy to clipboard");

    // 3. Missing code element (textToCopy is null) -> treated as failure
    const btnMissing = createMockButton(true);
    const resMissing = await executeCodeBlockCopy(btnMissing, null, async () => true, timers);
    assert.equal(resMissing.success, false);
    assert.equal(btnMissing.getAttribute("data-copied"), "error");
    assert.equal(btnMissing.getAttribute("aria-label"), "Failed to copy to clipboard");

    // 4. Timer race / repeat click
    const btnRepeat = createMockButton(true);
    let timerCleared = false;
    const origClearTimeout = globalThis.clearTimeout;
    globalThis.clearTimeout = ((id: any) => {
      timerCleared = true;
      origClearTimeout(id);
    }) as any;

    try {
      const res1 = await executeCodeBlockCopy(btnRepeat, "sample", async () => true, timers);
      const res2 = await executeCodeBlockCopy(btnRepeat, "sample", async () => true, timers);

      assert.equal(timerCleared, true, "Previous timer should be cleared on repeat click");
      assert.notEqual(res1.timerId, res2.timerId, "New timer id should replace the old one");
    } finally {
      globalThis.clearTimeout = origClearTimeout;
    }

    // 5. Detached button
    const btnDetached = createMockButton(false);
    const resDetached = await executeCodeBlockCopy(btnDetached, "sample", async () => true, timers);
    assert.equal(resDetached.success, true);
    assert.equal(resDetached.timerId, null);
    assert.equal(btnDetached.getAttribute("data-copied"), null);
  });

  it("copy listener does not stop event propagation (preventDefault only)", () => {
    let defaultPrevented = false;
    let propagationStopped = false;
    let immediatePropagationStopped = false;

    const mockButton = {
      tagName: "BUTTON",
      nodeType: 1,
      isConnected: true,
      closest(sel: string) {
        if (sel === "[data-code-copy]") return mockButton;
        if (sel === ".fenced-code-block") return { querySelector: () => ({ textContent: "copied code" }) };
        return null;
      },
      setAttribute() {},
      removeAttribute() {},
      getAttribute() { return null; },
    };

    let registeredListener: ((e: any) => void) | null = null;
    const fakeDoc = {
      addEventListener(type: string, fn: any) {
        registeredListener = fn;
      },
      removeEventListener() {},
    };

    const origDoc = globalThis.document;
    (globalThis as any).document = fakeDoc;

    try {
      setupCodeBlockCopyListener(async () => true);
      assert.ok(registeredListener, "listener registered");

      const mockEvent = {
        target: mockButton,
        preventDefault() { defaultPrevented = true; },
        stopPropagation() { propagationStopped = true; },
        stopImmediatePropagation() { immediatePropagationStopped = true; },
      };

      (registeredListener as any)(mockEvent);

      assert.equal(defaultPrevented, true, "preventDefault should be called");
      assert.equal(propagationStopped, false, "stopPropagation must NOT be called so outside listeners see the event");
      assert.equal(immediatePropagationStopped, false, "stopImmediatePropagation must NOT be called");
    } finally {
      (globalThis as any).document = origDoc;
    }
  });

  it("delegated copy listener setup is safe when document is undefined", () => {
    const unsub = setupCodeBlockCopyListener(async () => true);
    assert.equal(typeof unsub, "function");
    unsub();
  });
});
