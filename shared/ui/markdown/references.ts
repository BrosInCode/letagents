/**
 * Turns known message ids (msg_12) and task ids (task_7) in rendered Markdown
 * into buttons the room handles: a message link jumps to that message, a task
 * link opens its preview. Only ids the room knows become buttons, and ids
 * inside links, buttons and code stay text.
 */
const messageOrTaskReference = /\b(?:msg|task)_\d+/;

/**
 * True when the HTML can hold a message or task reference at all. Callers use
 * it to skip the link pass, and to avoid reading the reference sets (so a
 * message with no references never depends on them).
 */
export function mayContainMessageReference(html: string): boolean {
  return messageOrTaskReference.test(html);
}

/** Decorate only HTML already escaped by renderMarkdown. */
export function linkRenderedMessageReferences(
  html: string,
  messageReferenceIds?: ReadonlySet<string>,
  taskReferenceIds?: ReadonlySet<string>,
): string {
  if (!mayContainMessageReference(html)) return html;
  return linkTaskReferences(linkMessageReferences(html, messageReferenceIds), taskReferenceIds);
}

function linkMessageReferences(html: string, messageReferenceIds?: ReadonlySet<string>): string {
  if (!messageReferenceIds) return html;
  const chunks = html.split(/(<[^>]+>)/g);
  const skipStack: string[] = [];
  return chunks
    .map((chunk) => {
      if (!chunk) return "";
      if (chunk.startsWith("<") && chunk.endsWith(">")) {
        updateSkipStack(skipStack, chunk);
        return chunk;
      }
      if (skipStack.length) return chunk;
      return chunk.replace(/\bmsg_\d+\b/g, (messageId) => {
        if (!messageReferenceIds.has(messageId)) return messageId;
        return [
          '<button class="message-reference-link" type="button"',
          ` data-message-reference-id="${messageId}"`,
          ` title="Jump to ${messageId}">`,
          messageId,
          "</button>",
        ].join("");
      });
    })
    .join("");
}

function linkTaskReferences(html: string, taskReferenceIds?: ReadonlySet<string>): string {
  if (!taskReferenceIds) return html;
  const chunks = html.split(/(<[^>]+>)/g);
  const skipStack: string[] = [];
  return chunks
    .map((chunk) => {
      if (!chunk) return "";
      if (chunk.startsWith("<") && chunk.endsWith(">")) {
        updateSkipStack(skipStack, chunk);
        return chunk;
      }
      if (skipStack.length) return chunk;
      return chunk.replace(/\btask_\d+\b/g, (taskId) => {
        if (!taskReferenceIds.has(taskId)) return taskId;
        return [
          '<button class="message-reference-link task-reference-link" type="button"',
          ` data-task-reference-id="${taskId}"`,
          ` title="Preview ${taskId}">`,
          taskId,
          "</button>",
        ].join("");
      });
    })
    .join("");
}

function updateSkipStack(skipStack: string[], tag: string): void {
  const tagMatch = /^<\/?\s*([A-Za-z0-9-]+)/.exec(tag);
  if (!tagMatch) return;
  const tagName = tagMatch[1]!.toLowerCase();
  if (!["a", "button", "code"].includes(tagName)) return;
  if (/^<\//.test(tag)) {
    const index = skipStack.lastIndexOf(tagName);
    if (index >= 0) skipStack.splice(index, 1);
    return;
  }
  if (!/\/\s*>$/.test(tag)) {
    skipStack.push(tagName);
  }
}
