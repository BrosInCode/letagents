import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const css = readFileSync(new URL('../src/styles/surfaces/first-run.css', import.meta.url), 'utf8');

test('setup steps fill the window, so the action buttons stay in view and only the middle row scrolls', () => {
  assert.match(css, /\.first-run-wizard:not\(\[data-stage="welcome"\]\) \{[^}]*grid-template-rows: minmax\(0, 1fr\);/);
  assert.match(css, /\.first-run-card \{[^}]*grid-template-rows: auto minmax\(0, 1fr\) auto auto;/);
  assert.match(css, /\.first-run-stage-viewport \{\s*overflow: hidden auto;/);
});

test('a short window gets a smaller setup step, as on Windows at 125–150% scaling', () => {
  assert.match(css, /@media \(max-height: 800px\) \{[\s\S]*\.first-run-card \.mcp-install-step \{\s*min-height: 0;/);
});
