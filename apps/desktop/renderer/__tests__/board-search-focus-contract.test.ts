import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const styles = readFileSync(fileURLToPath(new URL(
  "../src/styles/task-board/board-layout-filters.css",
  import.meta.url,
)), "utf8");

function rule(selector: string): string {
  const start = styles.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `missing rule: ${selector}`);
  return styles.slice(start, styles.indexOf("}", start));
}

test("the board search box shows one focus ring, not a square one inside a rounded one", () => {
  // Every control in the panel gets an outline when focused.
  assert.match(rule(".desktop-board-panel :is(button, a, input, textarea, select, [tabindex]):focus-visible"), /outline:\s*2px solid/);
  // The search input is the exception: its rounded box is the ring, and the
  // box's full-blue border is what makes that ring visible enough.
  const box = rule(".desktop-board-search:focus-within");
  assert.match(box, /border-color:\s*var\(--blue\);/);
  assert.match(box, /box-shadow:\s*0 0 0 3px/);
  // The exception names the input element as well as the panel's classes, so
  // it is more specific than the panel-wide rule. It uses the outline
  // shorthand, which also cancels the wider outline asked for with more contrast.
  assert.match(rule(".desktop-board-panel .desktop-board-search input:focus-visible"), /\boutline:\s*0;/);
});
