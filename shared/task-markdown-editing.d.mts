export type MarkdownTool = 'bold' | 'italic' | 'strike' | 'heading' | 'bullet' | 'number' | 'check' | 'quote' | 'code' | 'link';
export interface TaskContentPatch {
  title?: string;
  description?: string;
  expected_content: { title?: string; description?: string };
}
export function taskContentPatch(original: { title: string; description: string }, draft: { title: string; description: string }): TaskContentPatch;
export const markdownTools: ReadonlyArray<{ id: MarkdownTool; label: string; symbol: string }>;
export function applyMarkdownTool(value: string, start: number, end: number, tool: MarkdownTool): { value: string; start: number; end: number };
