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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function renderMessageReference(messageId: string): string {
  return [
    '<button type="button" class="message-ref-token"',
    ` data-message-ref-id="${escapeAttribute(messageId)}"`,
    ` aria-label="${escapeAttribute(`Open ${messageId}`)}">`,
    escapeHtml(messageId),
    '</button>',
  ].join('')
}

function renderPlainInline(text: string): string {
  const tokenPattern = /(https?:\/\/[^\s<"']+)|(^|[\s(])@([A-Za-z0-9._-]+)|(^|[\s([{"',;])(msg_\d+)\b(?=$|[\s)\]},!?:;'"]|\.(?=\s|$))/g
  let rendered = ''
  let index = 0
  let match: RegExpExecArray | null

  while ((match = tokenPattern.exec(text)) !== null) {
    rendered += escapeHtml(text.slice(index, match.index))

    const url = match[1]
    const mentionPrefix = match[2]
    const mentionName = match[3]
    const messagePrefix = match[4]
    const messageId = match[5]

    if (url) {
      const safeUrl = escapeHtml(url)
      const safeHref = escapeAttribute(url)
      rendered += `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${safeUrl}</a>`
      index = match.index + url.length
      continue
    }

    if (mentionName !== undefined) {
      rendered += escapeHtml(mentionPrefix || '')
      rendered += `<span class="mention-token">@${escapeHtml(mentionName)}</span>`
      index = match.index + (mentionPrefix || '').length + mentionName.length + 1
      continue
    }

    if (messageId !== undefined) {
      rendered += escapeHtml(messagePrefix || '')
      rendered += renderMessageReference(messageId)
      index = match.index + (messagePrefix || '').length + messageId.length
    }
  }

  rendered += escapeHtml(text.slice(index))
  return rendered
}

function renderStrongInline(text: string): string {
  const strongPattern = /\*\*([^\n]*?)\*\*/g
  let rendered = ''
  let index = 0
  let match: RegExpExecArray | null

  while ((match = strongPattern.exec(text)) !== null) {
    rendered += renderPlainInline(text.slice(index, match.index))
    rendered += `<strong>${renderPlainInline(match[1] || '')}</strong>`
    index = match.index + match[0].length
  }

  rendered += renderPlainInline(text.slice(index))
  return rendered
}

export function renderMessageContent(text: string): string {
  const codePattern = /`([^`]+)`/g
  let rendered = ''
  let index = 0
  let match: RegExpExecArray | null

  while ((match = codePattern.exec(text)) !== null) {
    rendered += renderStrongInline(text.slice(index, match.index))
    rendered += `<code>${escapeHtml(match[1] || '')}</code>`
    index = match.index + match[0].length
  }

  rendered += renderStrongInline(text.slice(index))
  return rendered.replace(/\n/g, '<br>')
}
