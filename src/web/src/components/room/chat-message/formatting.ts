import {
  attentionResponseDisplayText,
  attentionResponseHandle,
} from '../../../../../../shared/room-knowledge.mjs'
import { renderMarkdown } from '../../../../../../shared/ui/markdown/markdown'

export { isAmbientSystemMessage, stripStatusPrefix } from '../../../../../../shared/ui/room-messages'

/**
 * The text people see for a room message. A person's Needs-you answer carries
 * the asking agent's handle and the request id for that agent's routing; the
 * room reads it as a reply to the agent by name instead.
 */
export function messageDisplayText(
  message: { text: string; display_text?: string | null; source?: string | null },
  agentNames?: ReadonlyMap<string, string>,
): string {
  if (message.display_text) return message.display_text
  if (message.source === 'browser') {
    const answer = attentionResponseDisplayText(message.text, handle => agentNames?.get(handle))
    if (answer !== null) return answer
  }
  return message.text
}

/**
 * Room search. What people read and what was sent both match, so "@Amber"
 * finds a Needs-you answer as well as its raw handle does.
 */
export function messageMatchesSearch(
  message: { text: string; display_text?: string | null; source?: string | null; sender?: string | null },
  normalizedQuery: string,
  agentNames?: ReadonlyMap<string, string>,
): boolean {
  // Stored messages can lack text (attachment-only or partial payloads).
  return [message.display_text || message.text || '', String(messageDisplayText(message, agentNames) ?? ''), message.sender || '']
    .some(value => value.toLowerCase().includes(normalizedQuery))
}

/** Room agents' names keyed by the handle a Needs-you answer uses to wake them. */
export function attentionResponseAgentNames(
  people: Iterable<{ agent_key: string | null; display_name: string | null }>,
): ReadonlyMap<string, string> {
  const names = new Map<string, string>()
  for (const person of people) {
    const handle = attentionResponseHandle(person.agent_key)
    const name = person.display_name?.split('|')[0]?.trim()
    if (handle && name && !names.has(handle)) names.set(handle, name)
  }
  return names
}

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

/**
 * Room message Markdown, rendered by the renderer the desktop app uses too,
 * then known task ids become Board links.
 */
/**
 * A task description: full file paths and link labels stay, and @names are
 * plain text, as on the desktop Board. `editing` skips the render cache for a
 * preview that changes on every keystroke.
 */
export function renderTaskMarkdown(text: string, editing = false): string {
  return renderMarkdown(text, { block: true, mentions: false, preservePaths: true, noCache: editing })
}

export function renderMessageContent(text: string, taskReferenceIds?: ReadonlySet<string>, onLink?: (url: string) => void): string {
  return linkTaskReferences(renderMarkdown(text, { block: true, onLink }), taskReferenceIds)
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
        ` title="Preview ${taskId}">`,
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
