export function formatMessageTime(timestamp: string, now = new Date()): string {
  try {
    const date = new Date(timestamp)
    const isToday = date.toDateString() === now.toDateString()
    if (isToday) {
      return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    }
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

export function isAmbientSystemMessage(sender: string, text: string): boolean {
  const normalizedSender = String(sender || '').trim().toLowerCase()
  const normalizedText = String(text || '')
  return ['letagents', 'system'].includes(normalizedSender)
    && /^\[status\]\s*/i.test(normalizedText)
    && !/\b(stale|blocked|failed|error|cannot|can't|cancelled)\b/i.test(normalizedText)
}

export function stripStatusPrefix(text: string): string {
  return String(text || '').replace(/^\[status\]\s*/i, '').trim()
}

const MAX_BLOCKQUOTE_DEPTH = 8

export function renderMessageContent(text: string, taskReferenceIds?: ReadonlySet<string>): string {
  return linkTaskReferences(renderMessageBlocks(text), taskReferenceIds)
}

function linkTaskReferences(html: string, taskReferenceIds?: ReadonlySet<string>): string {
  if (!taskReferenceIds?.size) return html
  const chunks = html.split(/(<[^>]+>)/g)
  const skipStack: string[] = []
  return chunks.map((chunk) => {
    if (!chunk) return ''
    if (chunk.startsWith('<') && chunk.endsWith('>')) {
      updateReferenceSkipStack(skipStack, chunk)
      return chunk
    }
    if (skipStack.length) return chunk
    return chunk.replace(/\btask_\d+\b/g, (taskId) => {
      if (!taskReferenceIds.has(taskId)) return taskId
      return [
        '<button class="task-reference-link" type="button"',
        ` data-task-reference-id="${taskId}"`,
        ` title="Open ${taskId} on the Board">`,
        taskId,
        '</button>',
      ].join('')
    })
  }).join('')
}

function updateReferenceSkipStack(skipStack: string[], tag: string): void {
  const tagMatch = /^<\/?\s*([A-Za-z0-9-]+)/.exec(tag)
  if (!tagMatch) return
  const tagName = tagMatch[1]!.toLowerCase()
  if (!['a', 'button', 'code'].includes(tagName)) return
  if (/^<\//.test(tag)) {
    const index = skipStack.lastIndexOf(tagName)
    if (index >= 0) skipStack.splice(index, 1)
    return
  }
  if (!/\/\s*>$/.test(tag)) skipStack.push(tagName)
}

function renderMessageBlocks(value: string, quoteDepth = 0): string {
  const lines = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const blocks: string[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]!
    const trimmed = line.trim()
    if (!trimmed) {
      index += 1
      continue
    }

    const fence = /^```([A-Za-z0-9_+-]*)\s*$/.exec(trimmed)
    if (fence) {
      const code: string[] = []
      index += 1
      while (index < lines.length && !/^```\s*$/.test(lines[index]!.trim())) {
        code.push(lines[index]!)
        index += 1
      }
      if (index < lines.length) index += 1
      const language = fence[1] ? ` class="language-${escapeAttribute(fence[1])}"` : ''
      blocks.push(`<pre><code${language}>${escapeHtml(code.join('\n'))}</code></pre>`)
      continue
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed)
    if (heading) {
      const level = heading[1]!.length
      blocks.push(`<h${level}>${renderMessageInline(heading[2]!)}</h${level}>`)
      index += 1
      continue
    }

    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push('<hr>')
      index += 1
      continue
    }

    if (/^>\s?/.test(trimmed)) {
      const quote: string[] = []
      while (index < lines.length && /^>\s?/.test(lines[index]!.trim())) {
        quote.push(lines[index]!.trim().replace(/^>\s?/, ''))
        index += 1
      }
      const quoteBody = quoteDepth >= MAX_BLOCKQUOTE_DEPTH
        ? `<p>${renderMessageInline(quote.map(value => value.replace(/^>+\s?/, '')).join('\n')).replace(/\n/g, '<br>')}</p>`
        : renderMessageBlocks(quote.join('\n'), quoteDepth + 1)
      blocks.push(`<blockquote>${quoteBody}</blockquote>`)
      continue
    }

    const firstItem = listItem(line)
    if (firstItem) {
      const ordered = firstItem.ordered
      const items: string[] = []
      while (index < lines.length) {
        const item = listItem(lines[index]!)
        if (!item || item.ordered !== ordered) break
        items.push(renderListItem(item.text))
        index += 1
      }
      const tag = ordered ? 'ol' : 'ul'
      blocks.push(`<${tag}>${items.map(item => `<li>${item}</li>`).join('')}</${tag}>`)
      continue
    }

    const paragraph: string[] = []
    while (index < lines.length && lines[index]!.trim() && !startsMarkdownBlock(lines[index]!)) {
      paragraph.push(lines[index]!)
      index += 1
    }
    if (!paragraph.length) {
      paragraph.push(line)
      index += 1
    }
    blocks.push(`<p>${renderMessageInline(paragraph.join('\n')).replace(/\n/g, '<br>')}</p>`)
  }

  return blocks.join('')
}

function renderMessageInline(value: string): string {
  const tokens: string[] = []
  const tokenized = value.replace(/`([^`\n]+)`/g, (_match, code: string) =>
    markdownToken(tokens, `<code>${escapeHtml(code)}</code>`)
  )
  let rendered = escapeHtml(tokenized)

  rendered = rendered.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label: string, url: string) => {
    const normalizedUrl = url.replace(/&amp;/g, '&')
    return markdownToken(tokens, `<a href="${escapeAttribute(normalizedUrl)}" target="_blank" rel="noopener noreferrer">${label}</a>`)
  })
  rendered = rendered.replace(/(https?:\/\/[^\s<"']+)/g, (_match, url: string) => {
    const normalizedUrl = url.replace(/&amp;/g, '&')
    return markdownToken(tokens, `<a href="${escapeAttribute(normalizedUrl)}" target="_blank" rel="noopener noreferrer">${url}</a>`)
  })
  rendered = rendered
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/~~(.+?)~~/g, '<del>$1</del>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])@([A-Za-z0-9._:-]+(?:\/[A-Za-z0-9._-]+)*)/g, '$1<span class="mention-token">@$2</span>')

  return restoreMarkdownTokens(rendered, tokens)
}

function renderListItem(value: string): string {
  const task = /^\[([ xX])\]\s+(.+)$/.exec(value)
  if (!task) return renderMessageInline(value)
  const checked = task[1]!.toLowerCase() === 'x' ? ' checked' : ''
  return `<input class="markdown-task-checkbox" type="checkbox" disabled${checked}>${renderMessageInline(task[2]!)}`
}

function listItem(line: string): { ordered: boolean; text: string } | null {
  const unordered = /^\s*[-*+]\s+(.+)$/.exec(line)
  if (unordered) return { ordered: false, text: unordered[1]! }
  const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line)
  return ordered ? { ordered: true, text: ordered[1]! } : null
}

function startsMarkdownBlock(line: string): boolean {
  const trimmed = line.trim()
  return /^```/.test(trimmed)
    || /^#{1,6}\s+/.test(trimmed)
    || /^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)
    || /^>\s?/.test(trimmed)
    || Boolean(listItem(line))
}

function markdownToken(tokens: string[], html: string): string {
  const index = tokens.push(html) - 1
  return `\u0000MD${index}\u0000`
}

function restoreMarkdownTokens(value: string, tokens: string[]): string {
  return value.replace(/\u0000MD(\d+)\u0000/g, (_match, index: string) => tokens[Number(index)] || '')
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/'/g, '&#39;')
}
