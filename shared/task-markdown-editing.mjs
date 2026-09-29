export const markdownTools = [
  { id: 'bold', label: 'Bold', symbol: 'B' },
  { id: 'italic', label: 'Italic', symbol: 'I' },
  { id: 'strike', label: 'Strikethrough', symbol: 'S' },
  { id: 'heading', label: 'Heading', symbol: 'H2' },
  { id: 'bullet', label: 'Bullet list', symbol: 'List' },
  { id: 'number', label: 'Numbered list', symbol: '1.' },
  { id: 'check', label: 'Checklist', symbol: '[ ]' },
  { id: 'quote', label: 'Quote', symbol: 'Quote' },
  { id: 'code', label: 'Code block', symbol: '</>' },
  { id: 'link', label: 'Link', symbol: 'Link' },
];

export function taskContentPatch(original, draft) {
  const patch = { expected_content: {} };
  for (const field of ['title', 'description']) {
    if (draft[field] !== original[field]) {
      patch[field] = draft[field];
      patch.expected_content[field] = original[field];
    }
  }
  return patch;
}

export function applyMarkdownTool(value, start, end, tool) {
  const selected = value.slice(start, end);
  const wrappers = { bold: ['**', '**'], italic: ['_', '_'], strike: ['~~', '~~'], link: ['[', '](https://)'] };
  const wrapper = wrappers[tool];
  if (wrapper) {
    const text = selected || 'text';
    return {
      value: value.slice(0, start) + wrapper[0] + text + wrapper[1] + value.slice(end),
      start: start + wrapper[0].length,
      end: start + wrapper[0].length + text.length,
    };
  }
  if (tool === 'code') {
    const before = start > 0 && value[start - 1] !== '\n' ? '\n' : '';
    const after = end < value.length && value[end] !== '\n' ? '\n' : '';
    const text = selected || 'code';
    const prefix = before + '```\n';
    return { value: value.slice(0, start) + prefix + text + '\n```' + after + value.slice(end), start: start + prefix.length, end: start + prefix.length + text.length };
  }
  const prefixes = { heading: '## ', bullet: '- ', number: '1. ', check: '- [ ] ', quote: '> ' };
  if (!(tool in prefixes)) return { value, start, end };
  const lineStart = start === 0 ? 0 : value.lastIndexOf('\n', start - 1) + 1;
  const selectionEnd = end > start && value[end - 1] === '\n' ? end - 1 : end;
  const nextNewline = value.indexOf('\n', selectionEnd);
  const lineEnd = nextNewline === -1 ? value.length : nextNewline;
  const lines = value.slice(lineStart, lineEnd).split('\n');
  const next = lines.map((line, index) => (tool === 'number' ? (index + 1) + '. ' : prefixes[tool]) + (line || 'text')).join('\n');
  return { value: value.slice(0, lineStart) + next + value.slice(lineEnd), start: lineStart, end: lineStart + next.length };
}
