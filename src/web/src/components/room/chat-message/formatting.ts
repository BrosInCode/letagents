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

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

export function renderMessageContent(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/(https?:\/\/[^\s<"']+)/g, (_match, url: string) => {
      const safeHref = escapeAttribute(url.replace(/&amp;/g, '&'))
      return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${url}</a>`
    })
    .replace(/(^|[\s(])@([A-Za-z0-9._-]+)/g, '$1<span class="mention-token">@$2</span>')
    .replace(/\n/g, '<br>')
}
