import assert from "node:assert/strict";
import test from "node:test";
import { renderDesktopMarkdown } from "../src/components/desktop/content/formatting/markdown";

test("Room replies keep numbered steps when an agent separates them with blank lines", () => {
  const html = renderDesktopMarkdown("1. **See who is available.**\n\n2. **Ask the room for help.**", { block: true });
  assert.equal(html, '<ol><li><strong>See who is available.</strong></li></ol><ol start="2"><li><strong>Ask the room for help.</strong></li></ol>');
});

test("continued lists retain their starting number while ordinary lists keep normal numbering", () => {
  assert.equal(renderDesktopMarkdown("5) Five\n6) Six", { block: true }), '<ol start="5"><li>Five</li><li>Six</li></ol>');
  assert.equal(renderDesktopMarkdown("0. Zero", { block: true }), '<ol start="0"><li>Zero</li></ol>');
  assert.equal(renderDesktopMarkdown("1. One\n1. Two", { block: true }), '<ol><li>One</li><li>Two</li></ol>');
  assert.equal(renderDesktopMarkdown("- One\n- Two", { block: true }), '<ul><li>One</li><li>Two</li></ul>');
});
