import assert from "node:assert/strict";
import test from "node:test";
import { renderDesktopMarkdown } from "../src/components/desktop/content/formatting/markdown";
import { renderMessageText } from "../src/components/desktop/content/desktop-chat-message/message-rendering";

const block = (value: string, options: Parameters<typeof renderDesktopMarkdown>[1] = {}) =>
  renderDesktopMarkdown(value, { block: true, ...options });

test("an agent reply with a numbered item, bold lead-in, pipe table and indented lines renders cleanly", () => {
  const html = block([
    "1. **Pick a route.** The board has two options.",
    "   This line is indented and continues the item.",
    "",
    "**Recommendation:** take the second choice.",
    "  It keeps the flow simple.",
    "",
    "| Choice | What happens |",
    "|---|---|",
    "| Merge now | CI runs on `staging` |",
    "| Wait | Nothing \\| yet |",
    "",
    "    An indented paragraph is prose, not code.",
  ].join("\n"));
  assert.equal(html, [
    "<ol><li><strong>Pick a route.</strong> The board has two options.<br>This line is indented and continues the item.</li></ol>",
    "<p><strong>Recommendation:</strong> take the second choice.<br>It keeps the flow simple.</p>",
    '<div class="markdown-table-scroll"><table><thead><tr><th>Choice</th><th>What happens</th></tr></thead>',
    "<tbody><tr><td>Merge now</td><td>CI runs on <code>staging</code></td></tr><tr><td>Wait</td><td>Nothing | yet</td></tr></tbody></table></div>",
    "<p>An indented paragraph is prose, not code.</p>",
  ].join(""));
  assert.doesNotMatch(html, /\|---|<(?:br|p|li|td)>\s/);
});

test("table column alignment becomes a class, never an inline style", () => {
  const html = block("| L | C | R |\n|:--|:-:|--:|\n| 1 | 2 | 3 |");
  assert.match(html, /<td class="markdown-align-left">1<\/td><td class="markdown-align-center">2<\/td><td class="markdown-align-right">3<\/td>/);
  assert.doesNotMatch(html, /style=/);
});

test("nested bullets and list items with continuation paragraphs keep their structure", () => {
  assert.equal(
    block("- one\n  - two\n    - three\n- four"),
    "<ul><li>one<ul><li>two<ul><li>three</li></ul></li></ul></li><li>four</li></ul>",
  );
  assert.equal(
    block("1. First step\n\n   More about the first step.\n\n2. Second step"),
    "<ol><li><p>First step</p><p>More about the first step.</p></li><li>Second step</li></ol>",
  );
});

test("task list items keep the disabled checkbox, including nested tasks", () => {
  assert.equal(
    block("- [ ] Write tests\n- [x] Ship\n  - [ ] Announce"),
    '<ul><li><input class="markdown-task-checkbox" type="checkbox" disabled>Write tests</li>'
      + '<li><input class="markdown-task-checkbox" type="checkbox" disabled checked>Ship'
      + '<ul><li><input class="markdown-task-checkbox" type="checkbox" disabled>Announce</li></ul></li></ul>',
  );
});

test("fenced code keeps the desktop highlighter block and its language", () => {
  const html = block("Run this:\n\n```ts\nconst value = 1;\n```");
  assert.match(html, /^<p>Run this:<\/p><div class="fenced-code-block">/);
  assert.match(html, /data-lang="ts"/);
  assert.match(html, /<code class="fenced-code-block-content language-ts"><span class="hljs-keyword">const<\/span> value = <span class="hljs-number">1<\/span>;<\/code>/);
});

test("blockquotes nest and stay bounded", () => {
  assert.equal(block("> quote\n> > inner"), "<blockquote><p>quote</p><blockquote><p>inner</p></blockquote></blockquote>");
  const deep = block(`${">".repeat(20_000)} safe`);
  assert.match(deep, /safe/);
  assert.ok((deep.match(/<blockquote>/g) || []).length <= 9);
});

test("hostile nesting depth does not overflow the parser", () => {
  for (const value of ["- ".repeat(5_000) + "x", "- > ".repeat(3_000) + "x"]) {
    assert.match(block(value), /x/);
  }
});

test("raw HTML from a message is shown as text, never as markup", () => {
  const html = block("<script>alert(1)</script>\n\nhi <b>bold</b> <img src=x onerror=alert(1)>");
  assert.equal(
    html,
    "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p><p>hi &lt;b&gt;bold&lt;/b&gt; &lt;img src=x onerror=alert(1)&gt;</p>",
  );
});

test("links open in a new window and are reported to the link collector once", () => {
  const links: string[] = [];
  const html = block("See [the docs](https://example.com/a_b) and https://example.com/z", { onLink: (url) => links.push(url) });
  assert.equal(
    html,
    '<p>See <a href="https://example.com/a_b" target="_blank" rel="noopener noreferrer">the docs</a>'
      + ' and <a href="https://example.com/z" target="_blank" rel="noopener noreferrer">https://example.com/z</a></p>',
  );
  assert.deepEqual(links, ["https://example.com/a_b", "https://example.com/z"]);
  assert.match(block("[run](javascript:alert(1))"), /^<p>\[run\]\(javascript:alert\(1\)\)<\/p>$/);
});

test("file paths shorten to the file name unless paths are preserved", () => {
  assert.equal(block("Edit src/web/auth.ts and `src/api/auth.ts`"), "<p>Edit <code>auth.ts</code> and <code>auth.ts</code></p>");
  assert.equal(
    block("Edit src/web/auth.ts and `src/api/auth.ts`", { preservePaths: true }),
    "<p>Edit src/web/auth.ts and <code>src/api/auth.ts</code></p>",
  );
  assert.equal(block("| File |\n|---|\n| src/web/auth.ts |"), '<div class="markdown-table-scroll"><table><thead><tr><th>File</th></tr></thead><tbody><tr><td><code>auth.ts</code></td></tr></tbody></table></div>');
});

test("search highlight marks prose and table cells but not code", () => {
  assert.equal(
    renderMessageText("Find the **python** table\n\n| a | python |\n|-|-|\n| python | `python` |", "python"),
    '<p>Find the <strong><mark class="message-search-hit">python</mark></strong> table</p>'
      + '<div class="markdown-table-scroll"><table><thead><tr><th>a</th><th><mark class="message-search-hit">python</mark></th></tr></thead>'
      + '<tbody><tr><td><mark class="message-search-hit">python</mark></td><td><code>python</code></td></tr></tbody></table></div>',
  );
});

test("a list indented one level deeper on every line renders quickly and stays a list", () => {
  const value = Array.from({ length: 800 }, (_, level) => `${"  ".repeat(level)}- item ${level}`).join("\n");
  assert.ok(value.length > 600_000);
  renderDesktopMarkdown("- warm up", { block: true });
  // This synchronous parser test budgets its own work, not time preempted by
  // the other test-file processes running alongside it in CI.
  const started = process.cpuUsage();
  const html = block(value);
  const usage = process.cpuUsage(started);
  const elapsed = (usage.user + usage.system) / 1000;
  assert.ok(elapsed < 100, `rendering used ${elapsed.toFixed(1)} ms of CPU time`);
  assert.match(html, /^<ul><li>item 0<ul><li>item 1/);
  assert.match(html, /item 799/);
});
