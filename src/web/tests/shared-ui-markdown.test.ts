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

test('a link URL never takes in an earlier token, so code HTML cannot break out of href', () => {
  const attackInputs = [
    'https://a/`https://evil.test/onmouseover=alert(1)//`',
    '[x](https://a/`https://evil.test/onmouseover=alert(1)//`)',
    '[x](https://a/`" onmouseover="alert(1)`)',
    'https://a/`"><img src=x onerror=alert(1)>`',
  ]
  for (const input of attackInputs) {
    const html = renderMarkdown(input, { block: true, noCache: true })
    for (const [, tag, attributes] of html.matchAll(/<([a-z]+)\b([^>]*)>/g)) {
      const names = attributes.replace(/"[^"]*"/g, '').trim().split(/\s+/).filter(Boolean).map((part) => part.split('=')[0])
      assert.ok(names.every((name) => ['href', 'target', 'rel', 'class'].includes(name)), `${input} -> <${tag} ${names.join(' ')}>`)
    }
    assert.doesNotMatch(html, /<img|href="[^"]*</, input)
  }
  // Inline code inside a link label still renders (the reason tokens restore inside tokens).
  assert.match(renderMarkdown('[`code`](https://example.com/a)', { block: true, noCache: true }),
    /<a href="https:\/\/example\.com\/a"[^>]*><code>code<\/code><\/a>/)
})
