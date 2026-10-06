import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'
import hljs from 'highlight.js/lib/core'

import { renderMessageContent } from '../src/components/room/chat-message/formatting'
import { webHighlighter } from '../src/components/room/chat-message/code-highlighter'
import {
  MAX_HIGHLIGHT_CHARS,
  MAX_HIGHLIGHT_LINES,
  MAX_HIGHLIGHT_LINE_LENGTH,
  CodeHighlightCache,
  createCodeHighlighter,
  executeCodeBlockCopy,
  setupCodeBlockCopyListener,
  resolveLanguage,
} from '../../../shared/code-highlighting.mjs'

// Rendering assertions need a fresh budget with no wall-clock dependency.
// The sliding-window test below supplies its own advancing clock.
beforeEach((t) => {
  const highlighter = createCodeHighlighter({
    highlight: (code, language) => hljs.highlight(code, { language, ignoreIllegals: true }).value,
    now: () => 0,
  })
  t.mock.method(webHighlighter, 'renderCodeBlock', highlighter.renderCodeBlock)
})

function createMockButton(isConnected = true) {
  const attrs = new Map<string, string>()
  return {
    isConnected,
    setAttribute(name: string, val: string) {
      attrs.set(name, String(val))
    },
    removeAttribute(name: string) {
      attrs.delete(name)
    },
    getAttribute(name: string) {
      return attrs.get(name) ?? null
    },
  } as unknown as HTMLButtonElement
}

test('web: renders fenced code block with wrapper div, header, language badge, and copy button', () => {
  const input = ['```python', 'def greet(name):', '    return f"Hello, {name}"', '```'].join('\n')
  const html = renderMessageContent(input)

  assert.match(html, /<div class="fenced-code-block">/)
  assert.match(html, /<div class="fenced-code-block-header">/)
  assert.match(html, /<span class="fenced-code-block-lang" data-lang="python"><\/span>/)
  assert.match(
    html,
    /<button type="button" class="fenced-code-block-copy" data-code-copy aria-label="Copy code"><\/button>/,
  )
  assert.match(html, /<pre><code class="fenced-code-block-content language-python">/)
  assert.match(html, /<span class="hljs-keyword">def<\/span>/)
})

test('web: header elements contain zero text nodes', () => {
  const input = ['```typescript', 'const num: number = 42;', '```'].join('\n')
  const html = renderMessageContent(input)

  const headerMatch = /<div class="fenced-code-block-header">(.*?)<\/div>/.exec(html)
  assert.ok(headerMatch, 'header should exist')
  const headerInner = headerMatch[1]

  const textOnly = headerInner.replace(/<[^>]+>/g, '').trim()
  assert.equal(textOnly, '', 'header must contain zero text nodes')
})

test('web: alias languages display matched alias key (e.g. html, not xml)', () => {
  const input = ['```html', '<main><p>Web</p></main>', '```'].join('\n')
  const html = renderMessageContent(input)

  assert.match(html, /data-lang="html"/)
  assert.match(html, /class="fenced-code-block-content language-html"/)
  assert.match(html, /<span class="hljs-tag">&lt;<span class="hljs-name">main<\/span>&gt;<\/span>/)
})

test('web: unlabelled and unknown language tags omit label span, have no language class, and remain plain escaped text', () => {
  const unlabelled = renderMessageContent(['```', 'plain 123', '```'].join('\n'))
  assert.match(unlabelled, /<div class="fenced-code-block">/)
  assert.doesNotMatch(unlabelled, /class="fenced-code-block-lang"/)
  assert.doesNotMatch(unlabelled, /data-lang/)
  assert.match(unlabelled, /<code class="fenced-code-block-content">plain 123<\/code>/)
  assert.doesNotMatch(unlabelled, /language-/)

  const unknown = renderMessageContent(['```somecustomlanguage', 'foo = bar', '```'].join('\n'))
  assert.match(unknown, /<div class="fenced-code-block">/)
  assert.doesNotMatch(unknown, /class="fenced-code-block-lang"/)
  assert.doesNotMatch(unknown, /data-lang/)
  assert.match(unknown, /<code class="fenced-code-block-content">foo = bar<\/code>/)
  assert.doesNotMatch(unknown, /language-/)
  assert.doesNotMatch(unknown, /hljs-/)
})

test('web: prototype properties do not resolve as languages', () => {
  for (const prop of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) {
    assert.equal(resolveLanguage(prop), null, `${prop} must not resolve as language`)

    const input = ['```' + prop, 'const a = 1;', '```'].join('\n')
    const html = renderMessageContent(input)
    assert.match(html, /<div class="fenced-code-block">/)
    assert.doesNotMatch(html, /class="fenced-code-block-lang"/)
    assert.doesNotMatch(html, /data-lang/)
    assert.doesNotMatch(html, /hljs-/)
  }
})

test('web: diff blocks highlight additions, deletions, and hunk headers', () => {
  const input = ['```diff', '@@ -1,2 +1,2 @@', '-old line', '+new line', '```'].join('\n')
  const html = renderMessageContent(input)

  assert.match(html, /<span class="hljs-meta">@@ -1,2 \+1,2 @@<\/span>/)
  assert.match(html, /<span class="hljs-deletion">-old line<\/span>/)
  assert.match(html, /<span class="hljs-addition">\+new line<\/span>/)
})

test('web: markdown/md language tag is dropped and renders as plain unhighlighted text', () => {
  for (const tag of ['markdown', 'md']) {
    assert.equal(resolveLanguage(tag), null)
    const input = ['```' + tag, '# Heading', '[link](url)', '```'].join('\n')
    const html = renderMessageContent(input)

    assert.match(html, /<div class="fenced-code-block">/)
    assert.doesNotMatch(html, /class="fenced-code-block-lang"/)
    assert.doesNotMatch(html, /data-lang/)
    assert.doesNotMatch(html, /class="hljs-/)
    assert.match(html, /<code class="fenced-code-block-content"># Heading\n\[link\]\(url\)<\/code>/)
  }
})

test('web: safely escapes hostile HTML and avoids XSS in code blocks', () => {
  const hostile = '</code></pre><script>alert(1)</script><img src=x onerror=alert(2)>'
  const html = renderMessageContent(['```javascript', hostile, '```'].join('\n'))

  assert.doesNotMatch(html, /<script[\s>]/)
  assert.doesNotMatch(html, /<img[\s>]/)
  assert.doesNotMatch(html, /onerror=/i)
  assert.match(html, /&lt;.*?script.*?alert\(1\)/)
})

test('web: malformed fence tags (e.g. js" onclick=) render as ordinary escaped text', () => {
  const input = '```js" onclick="alert(1)\nconsole.log(1)'
  const html = renderMessageContent(input)

  assert.doesNotMatch(html, /<div class="fenced-code-block">/)
  assert.doesNotMatch(html, /<button/)
  assert.doesNotMatch(html, /<[a-z0-9]+[^>]*onclick=/i)
  assert.match(html, /&quot; onclick=&quot;alert\(1\)/)
})

test('web: structural test over hostile corpus verifies tag and attribute allowlists', () => {
  const hostileCorpus = [
    '```javascript\n</code></pre><script>alert("xss")</script><img src=x onerror=alert(1)>\n```',
    '```html\n<div onmouseover="evil()" style="color:red"><iframe src="about:blank"></iframe></div>\n```',
    '```python\nimport os\nos.system("rm -rf /") # <b>test</b> & <script>\n```',
    '```diff\n@@ -1 +1 @@\n-<svg onload="alert(1)">\n+&lt;clean&gt;\n```',
    '```\nplain text with <style>body{display:none}</style> and &quot;\n```',
  ]

  const allowedTags = new Set(['div', 'span', 'button', 'pre', 'code'])

  for (const input of hostileCorpus) {
    const html = renderMessageContent(input)

    const tagRegex = /<([a-zA-Z0-9]+)([^>]*)>/g
    let match: RegExpExecArray | null
    while ((match = tagRegex.exec(html)) !== null) {
      const tagName = match[1]!.toLowerCase()
      assert.ok(allowedTags.has(tagName), `Tag <${tagName}> must be in allowedTags`)

      const rawAttrs = match[2]!.trim()
      if (tagName === 'span') {
        const validSpan =
          /^class="[a-zA-Z0-9_-]+(?: [a-zA-Z0-9_-]+)*"$/.test(rawAttrs) ||
          /^class="fenced-code-block-lang" data-lang="[a-zA-Z0-9_+ -]+"$/.test(rawAttrs)
        assert.ok(validSpan, `Span attribute string "${rawAttrs}" violates allowlist`)
      } else if (tagName === 'button') {
        const validButton =
          /^type="button" class="fenced-code-block-copy" data-code-copy aria-label="Copy code"$/.test(rawAttrs)
        assert.ok(validButton, `Button attribute string "${rawAttrs}" violates allowlist`)
      } else if (tagName === 'div') {
        const validDiv =
          rawAttrs === 'class="fenced-code-block"' || rawAttrs === 'class="fenced-code-block-header"'
        assert.ok(validDiv, `Div attribute string "${rawAttrs}" violates allowlist`)
      } else if (tagName === 'code') {
        const validCode =
          /^class="fenced-code-block-content(?: language-[a-zA-Z0-9_+ -]+)?"$/.test(rawAttrs)
        assert.ok(validCode, `Code attribute string "${rawAttrs}" violates allowlist`)
      } else if (tagName === 'pre') {
        assert.equal(rawAttrs, '', `Pre tag must have no attributes, got "${rawAttrs}"`)
      }
    }
  }
})

test('web: skips highlighting when exceeding max characters, lines, or line length', () => {
  const hugeChars = 'const a = 1;\n'.repeat(450)
  assert.ok(hugeChars.length > MAX_HIGHLIGHT_CHARS)
  const resultChars = webHighlighter.renderCodeBlock(hugeChars, 'javascript')
  assert.match(resultChars, /<div class="fenced-code-block">/)
  assert.doesNotMatch(resultChars, /class="hljs-/)

  const exact250Lines = Array.from({ length: 250 }, (_, i) => `let val${i} = ${i}`).join('\n')
  assert.equal(exact250Lines.split('\n').length, 250)
  const result250 = webHighlighter.renderCodeBlock(exact250Lines, 'javascript')
  assert.match(result250, /class="hljs-/)

  const lines251 = Array.from({ length: 251 }, (_, i) => `let val${i} = ${i}`).join('\n')
  assert.equal(lines251.split('\n').length, 251)
  const result251 = webHighlighter.renderCodeBlock(lines251, 'javascript')
  assert.doesNotMatch(result251, /class="hljs-/)

  const longLine = 'const a = ' + 'x'.repeat(MAX_HIGHLIGHT_LINE_LENGTH)
  const resultLong = webHighlighter.renderCodeBlock(longLine, 'javascript')
  assert.doesNotMatch(resultLong, /class="hljs-/)
})

test('web: sliding time budget: bounds computation to max budget per window, falls back uncached', () => {
  let fakeTime = 1000
  let highlightCalls = 0

  const budgetedHighlighter = createCodeHighlighter({
    highlight(code) {
      highlightCalls++
      fakeTime += 60 // each call takes 60ms of fake time
      return `<span class="hljs-keyword">${code}</span>`
    },
    now: () => fakeTime,
    maxBudgetMs: 100,
    windowMs: 1000,
  })

  // 1. First block: 0ms spent -> highlights, costs 60ms
  const block1 = budgetedHighlighter.renderCodeBlock('const a = 1;', 'javascript')
  assert.match(block1, /class="hljs-keyword"/)
  assert.equal(highlightCalls, 1)

  // 2. Second block: 60ms spent -> highlights, costs 60ms (spent = 120ms > 100ms)
  const block2 = budgetedHighlighter.renderCodeBlock('const b = 2;', 'javascript')
  assert.match(block2, /class="hljs-keyword"/)
  assert.equal(highlightCalls, 2)

  // 3. Third block: 120ms spent >= 100ms budget -> budget exhausted!
  const block3 = budgetedHighlighter.renderCodeBlock('const c = 3;', 'javascript')
  assert.doesNotMatch(block3, /class="hljs-keyword"/)
  assert.match(block3, /const c = 3;/)
  assert.equal(highlightCalls, 2, 'highlight should not be called when budget is exhausted')
  assert.equal(budgetedHighlighter.cache.get('javascript:const c = 3;'), undefined, 'fallback must not be cached')

  // 4. Cache hit test: re-rendering block1 returns cached highlighted HTML with zero time cost
  const block1Cached = budgetedHighlighter.renderCodeBlock('const a = 1;', 'javascript')
  assert.match(block1Cached, /class="hljs-keyword"/)
  assert.equal(highlightCalls, 2, 'cache hit should not invoke highlight or consume budget')

  // 5. Sliding window elapsed: advance time past 1000ms window
  fakeTime += 1001
  const block3AfterWindow = budgetedHighlighter.renderCodeBlock('const c = 3;', 'javascript')
  assert.match(block3AfterWindow, /class="hljs-keyword"/)
  assert.equal(highlightCalls, 3, 'should highlight again after window elapses')
  assert.ok(budgetedHighlighter.cache.get('javascript:const c = 3;') !== undefined, 'successful highlight is now cached')
})

test('web: adversarial corpus benchmark: all supported languages complete within bound (< 500 ms)', (t) => {
  // This benchmark measures the production clock and budget, unlike rendering assertions.
  t.mock.restoreAll()
  const lineWrap = (str: string, len = 500) => {
    const lines = []
    for (let i = 0; i < str.length; i += len) lines.push(str.slice(i, i + len))
    return lines.join('\n')
  }

  const cap = 4_500
  const adversarialPatterns = [
    lineWrap('"' + 'x'.repeat(cap)),
    lineWrap("'" + 'x'.repeat(cap)),
    lineWrap('`' + 'x'.repeat(cap)),
    lineWrap('/*' + 'x'.repeat(cap)),
    lineWrap('<!--' + 'x'.repeat(cap)),
    lineWrap('<'.repeat(cap)),
    lineWrap('('.repeat(cap)),
    lineWrap('{'.repeat(cap)),
    lineWrap('['.repeat(cap)),
    lineWrap('/'.repeat(cap)),
    lineWrap(':'.repeat(cap)),
    lineWrap('a'.repeat(cap)),
    lineWrap('a '.repeat(cap / 2)),
    lineWrap('a_'.repeat(cap / 2)),
    lineWrap('function if else return const let var while for switch case '.repeat(cap / 60)),
  ]

  const supportedLangs = [
    'javascript', 'typescript', 'python', 'bash', 'json', 'yaml', 'xml', 'css',
    'sql', 'diff', 'rust', 'go', 'c', 'cpp', 'java', 'csharp', 'dockerfile',
    'ruby', 'php', 'swift', 'kotlin', 'ini',
  ]

  for (const lang of supportedLangs) {
    for (const pattern of adversarialPatterns) {
      const t0 = performance.now()
      webHighlighter.renderCodeBlock(pattern, lang)
      const elapsed = performance.now() - t0
      assert.ok(
        elapsed < 500,
        `Adversarial input for ${lang} took ${elapsed} ms, exceeding 500 ms limit`,
      )
    }
  }
})

test('web: dual-bounded LRU cache bounds entries and total character size (keys + values)', () => {
  const cache = new CodeHighlightCache(2, 50)
  // 'key1' (4) + 'abc' (3) = 7; 'key2' (4) + 'def' (3) = 7; total = 14
  cache.set('key1', 'abc')
  cache.set('key2', 'def')
  assert.equal(cache.size, 2)
  assert.equal(cache.totalChars, 14)

  cache.set('key3', 'ghi')
  assert.equal(cache.size, 2)
  assert.equal(cache.get('key1'), undefined)
  assert.equal(cache.get('key2'), 'def')
  assert.equal(cache.get('key3'), 'ghi')
})

test('web: executeCodeBlockCopy handles success, failure, missing element, timer race, and detached button', async () => {
  // 1. Success state
  const btnSuccess = createMockButton(true)
  const timers = new WeakMap<HTMLButtonElement, number>()

  const resSuccess = await executeCodeBlockCopy(btnSuccess, 'code sample', async () => true, timers)
  assert.equal(resSuccess.success, true)
  assert.equal(btnSuccess.getAttribute('data-copied'), 'true')
  assert.equal(btnSuccess.getAttribute('aria-label'), 'Copied to clipboard')
  assert.ok(resSuccess.timerId !== null)

  // 2. Failure state
  const btnFail = createMockButton(true)
  const resFail = await executeCodeBlockCopy(
    btnFail,
    'code sample',
    async () => {
      throw new Error('Clipboard denied')
    },
    timers,
  )
  assert.equal(resFail.success, false)
  assert.equal(btnFail.getAttribute('data-copied'), 'error')
  assert.equal(btnFail.getAttribute('aria-label'), 'Failed to copy to clipboard')

  // 3. Missing code element (textToCopy is null) -> treated as failure
  const btnMissing = createMockButton(true)
  const resMissing = await executeCodeBlockCopy(btnMissing, null, async () => true, timers)
  assert.equal(resMissing.success, false)
  assert.equal(btnMissing.getAttribute('data-copied'), 'error')
  assert.equal(btnMissing.getAttribute('aria-label'), 'Failed to copy to clipboard')

  // 4. Timer race / repeat click
  const btnRepeat = createMockButton(true)
  let timerCleared = false
  const origClearTimeout = globalThis.clearTimeout
  globalThis.clearTimeout = ((id: any) => {
    timerCleared = true
    origClearTimeout(id)
  }) as any

  try {
    const res1 = await executeCodeBlockCopy(btnRepeat, 'sample', async () => true, timers)
    const res2 = await executeCodeBlockCopy(btnRepeat, 'sample', async () => true, timers)

    assert.equal(timerCleared, true, 'Previous timer should be cleared on repeat click')
    assert.notEqual(res1.timerId, res2.timerId, 'New timer id should replace the old one')
  } finally {
    globalThis.clearTimeout = origClearTimeout
  }

  // 5. Detached button
  const btnDetached = createMockButton(false)
  const resDetached = await executeCodeBlockCopy(btnDetached, 'sample', async () => true, timers)
  assert.equal(resDetached.success, true)
  assert.equal(resDetached.timerId, null)
  assert.equal(btnDetached.getAttribute('data-copied'), null)
})

test('web: copy listener does not stop event propagation (preventDefault only)', () => {
  let defaultPrevented = false
  let propagationStopped = false
  let immediatePropagationStopped = false

  const mockButton = {
    tagName: 'BUTTON',
    nodeType: 1,
    isConnected: true,
    closest(sel: string) {
      if (sel === '[data-code-copy]') return mockButton
      if (sel === '.fenced-code-block') return { querySelector: () => ({ textContent: 'copied code' }) }
      return null
    },
    setAttribute() {},
    removeAttribute() {},
    getAttribute() {
      return null
    },
  }

  let registeredListener: ((e: any) => void) | null = null
  const fakeDoc = {
    addEventListener(type: string, fn: any) {
      registeredListener = fn
    },
    removeEventListener() {},
  }

  const origDoc = globalThis.document
  ;(globalThis as any).document = fakeDoc

  try {
    setupCodeBlockCopyListener(async () => true)
    assert.ok(registeredListener, 'listener registered')

    const mockEvent = {
      target: mockButton,
      preventDefault() {
        defaultPrevented = true
      },
      stopPropagation() {
        propagationStopped = true
      },
      stopImmediatePropagation() {
        immediatePropagationStopped = true
      },
    }

    ;(registeredListener as any)(mockEvent)

    assert.equal(defaultPrevented, true, 'preventDefault should be called')
    assert.equal(propagationStopped, false, 'stopPropagation must NOT be called so outside listeners see the event')
    assert.equal(immediatePropagationStopped, false, 'stopImmediatePropagation must NOT be called')
  } finally {
    ;(globalThis as any).document = origDoc
  }
})

test('web: delegated copy listener is safe in Node environments without document', () => {
  const unsub = setupCodeBlockCopyListener(() => true)
  assert.equal(typeof unsub, 'function')
  unsub()
})
