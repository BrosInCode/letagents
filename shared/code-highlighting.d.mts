export type CanonicalLanguage =
  | 'javascript'
  | 'typescript'
  | 'python'
  | 'bash'
  | 'json'
  | 'yaml'
  | 'xml'
  | 'css'
  | 'sql'
  | 'diff'
  | 'rust'
  | 'go'
  | 'c'
  | 'cpp'
  | 'java'
  | 'csharp'
  | 'dockerfile'
  | 'ruby'
  | 'php'
  | 'swift'
  | 'kotlin'
  | 'ini';

export type LanguageAlias =
  | 'js'
  | 'jsx'
  | 'mjs'
  | 'cjs'
  | 'ts'
  | 'tsx'
  | 'mts'
  | 'cts'
  | 'py'
  | 'sh'
  | 'zsh'
  | 'shell'
  | 'yml'
  | 'html'
  | 'xhtml'
  | 'svg'
  | 'rs'
  | 'golang'
  | 'c++'
  | 'cc'
  | 'hpp'
  | 'h'
  | 'cs'
  | 'docker'
  | 'rb'
  | 'kt'
  | 'kts'
  | 'toml';

export type CodeHighlightLanguage = CanonicalLanguage;

export interface ResolvedLanguage {
  canonical: CanonicalLanguage;
  label: string;
}

export interface CodeHighlighterOptions {
  highlight: (code: string, canonicalLanguage: CanonicalLanguage) => string;
  now?: () => number;
  maxBudgetMs?: number;
  windowMs?: number;
}

export interface CodeHighlighter {
  renderCodeBlock(code: string, rawTag?: string): string;
  cache: CodeHighlightCache;
  resolveLanguage(rawTag?: string): ResolvedLanguage | null;
}

export const CANONICAL_LANGUAGES: readonly CanonicalLanguage[];
export const LANGUAGE_ALIASES: ReadonlyMap<string, CanonicalLanguage>;

export const MAX_HIGHLIGHT_CHARS: number;
export const MAX_HIGHLIGHT_LINES: number;
export const MAX_HIGHLIGHT_LINE_LENGTH: number;
export const MAX_CACHE_ENTRIES: number;
export const MAX_CACHE_CHARS: number;

export const DEFAULT_TIME_BUDGET_MS: number;
export const DEFAULT_TIME_WINDOW_MS: number;

export function escapeHtml(value: unknown): string;
export function escapeAttribute(value: unknown): string;
export function resolveLanguage(rawTag?: string): ResolvedLanguage | null;

export class CodeHighlightCache {
  constructor(maxEntries?: number, maxChars?: number);
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  clear(): void;
  readonly size: number;
  readonly totalChars: number;
}

export function createCodeHighlighter(options: CodeHighlighterOptions): CodeHighlighter;
export function executeCodeBlockCopy(
  button: HTMLButtonElement,
  textToCopy: string | null,
  copyFn: (text: string) => Promise<boolean> | boolean,
  copyTimers?: WeakMap<HTMLButtonElement, number>
): Promise<{ success: boolean; timerId: number | null }>;
export function setupCodeBlockCopyListener(
  copyFn: (text: string) => Promise<boolean> | boolean
): () => void;
