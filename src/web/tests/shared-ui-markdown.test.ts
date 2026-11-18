import assert from 'node:assert/strict'
import test from 'node:test'

import { renderMessageContent, renderTaskMarkdown } from '../src/components/room/chat-message/formatting'
import { renderMarkdown } from '../../../shared/ui/markdown/markdown'

test('the web draws tables and nested lists with the shared renderer', () => {
  const table = renderMessageContent('| Check | Result |\n|---|---|\n| web | pass |')
  assert.match(table, /<div class="markdown-table-scroll"><table><thead><tr><th>Check<\/th>/)
  assert.match(renderMessageContent('- a\n  - b\n- c'), /<li>a<ul><li>b<\/li><\/ul><\/li>/)
})

test('task descriptions keep full file paths; chat shows the file name, as on desktop', () => {
  const text = 'Update `src/web/package.json` and src/api/server.ts'
  const task = renderTaskMarkdown(text)
  assert.match(task, /<code>src\/web\/package\.json<\/code>/)
  assert.match(task, /src\/api\/server\.ts/)
  assert.match(renderMessageContent(text), /<code>package\.json<\/code>/)
})

test('task descriptions show @names as plain text', () => {
  assert.doesNotMatch(renderTaskMarkdown('ask @codex'), /mention-token/)
})

test('inline code inside a link label renders, not a leftover token', () => {
  const html = renderMarkdown('[`code`](https://example.com/a)', { block: true })
  assert.match(html, /<a href="https:\/\/example\.com\/a"[^>]*><code>code<\/code><\/a>/)
  assert.doesNotMatch(html, /MD\d|\u0000/)
})
