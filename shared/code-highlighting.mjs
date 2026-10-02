export const CANONICAL_LANGUAGES = Object.freeze([
  'javascript',
  'typescript',
  'python',
  'bash',
  'json',
  'yaml',
  'xml',
  'css',
  'sql',
  'diff',
  'rust',
  'go',
  'c',
  'cpp',
  'java',
  'csharp',
  'dockerfile',
  'ruby',
  'php',
  'swift',
  'kotlin',
  'ini',
]);

const CANONICAL_SET = new Set(CANONICAL_LANGUAGES);

export const LANGUAGE_ALIASES = new Map([
  // JavaScript
  ['js', 'javascript'],
  ['jsx', 'javascript'],
  ['mjs', 'javascript'],
  ['cjs', 'javascript'],
  // TypeScript
  ['ts', 'typescript'],
  ['tsx', 'typescript'],
  ['mts', 'typescript'],
  ['cts', 'typescript'],
  // Python
  ['py', 'python'],
  // Bash / Shell
  ['sh', 'bash'],
  ['zsh', 'bash'],
  ['shell', 'bash'],
  // YAML
  ['yml', 'yaml'],
  // XML / HTML / SVG
  ['html', 'xml'],
  ['xhtml', 'xml'],
  ['svg', 'xml'],
  // Rust
  ['rs', 'rust'],
  // Go
  ['golang', 'go'],
  // C / C++
  ['c++', 'cpp'],
  ['cc', 'cpp'],
  ['cxx', 'cpp'],
  ['hpp', 'cpp'],
  ['h', 'c'],
  // C#
  ['cs', 'csharp'],
  // Dockerfile
  ['docker', 'dockerfile'],
  // Ruby
  ['rb', 'ruby'],
  // Kotlin
  ['kt', 'kotlin'],
  ['kts', 'kotlin'],
  // INI / TOML
  ['toml', 'ini'],
]);

export const MAX_HIGHLIGHT_CHARS = 5_000;
export const MAX_HIGHLIGHT_LINES = 250;
export const MAX_HIGHLIGHT_LINE_LENGTH = 1_000;
export const MAX_CACHE_ENTRIES = 500;
export const MAX_CACHE_CHARS = 2_000_000;

export const DEFAULT_TIME_BUDGET_MS = 250;
export const DEFAULT_TIME_WINDOW_MS = 1_000;

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function escapeAttribute(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function resolveLanguage(rawTag) {
  if (!rawTag || typeof rawTag !== 'string') return null;
  const normalized = rawTag.trim().toLowerCase();
  if (!normalized) return null;

  if (CANONICAL_SET.has(normalized)) {
    return {
      canonical: normalized,
      label: normalized,
    };
  }

  const aliasTarget = LANGUAGE_ALIASES.get(normalized);
  if (aliasTarget && CANONICAL_SET.has(aliasTarget)) {
    return {
      canonical: aliasTarget,
      label: normalized,
    };
  }

  return null;
}

export class CodeHighlightCache {
  constructor(maxEntries = MAX_CACHE_ENTRIES, maxChars = MAX_CACHE_CHARS) {
    this.maxEntries = maxEntries;
    this.maxChars = maxChars;
    this.map = new Map();
    this.currentChars = 0;
  }

  get(key) {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key, value) {
    const entryChars = key.length + value.length;
    if (this.map.has(key)) {
      const oldVal = this.map.get(key);
      this.currentChars -= (key.length + oldVal.length);
      this.map.delete(key);
    }
    this.currentChars += entryChars;
    this.map.set(key, value);
    while (this.map.size > this.maxEntries || this.currentChars > this.maxChars) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey === undefined) break;
      const oldestVal = this.map.get(oldestKey);
      this.currentChars -= (oldestKey.length + oldestVal.length);
      this.map.delete(oldestKey);
    }
  }

  clear() {
    this.map.clear();
    this.currentChars = 0;
  }

  get size() {
    return this.map.size;
  }

  get totalChars() {
    return this.currentChars;
  }
}

export function createCodeHighlighter(options) {
  const highlight = options?.highlight;
  const now = options?.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const maxBudgetMs = options?.maxBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const windowMs = options?.windowMs ?? DEFAULT_TIME_WINDOW_MS;

  const cache = new CodeHighlightCache();

  // Sliding window execution time tracker
  // Worst-case main-thread freeze per second:
  // An attacker sending 200 distinct worst-case blocks in a single message can trigger
  // at most one block that starts when spentTime < 250ms (e.g. at 249ms plus one block
  // taking ~60ms), bounding synchronous computation to ~310ms per 1,000ms sliding window.
  // Once the 250ms budget is reached, subsequent blocks in that window immediately
  // fall back to plain escaped text (<0.01ms each) without caching the fallback.
  const budgetEntries = [];

  function getSpentTime(currentTime) {
    const cutoff = currentTime - windowMs;
    while (budgetEntries.length > 0 && budgetEntries[0].timestamp <= cutoff) {
      budgetEntries.shift();
    }
    let total = 0;
    for (let i = 0; i < budgetEntries.length; i++) {
      total += budgetEntries[i].duration;
    }
    return total;
  }

  function renderCodeBlock(code, rawTag) {
    const resolved = resolveLanguage(rawTag);
    const codeString = String(code ?? '');

    let exceedsSize = codeString.length > MAX_HIGHLIGHT_CHARS;
    if (!exceedsSize) {
      let lineCount = 1;
      let currentLineLen = 0;
      for (let i = 0; i < codeString.length; i++) {
        const ch = codeString.charCodeAt(i);
        if (ch === 10) {
          lineCount++;
          if (lineCount > MAX_HIGHLIGHT_LINES) {
            exceedsSize = true;
            break;
          }
          currentLineLen = 0;
        } else {
          currentLineLen++;
          if (currentLineLen > MAX_HIGHLIGHT_LINE_LENGTH) {
            exceedsSize = true;
            break;
          }
        }
      }
    }

    let codeHtml;
    if (!resolved || exceedsSize || typeof highlight !== 'function') {
      codeHtml = escapeHtml(codeString);
    } else {
      const cacheKey = `${resolved.canonical}:${codeString}`;
      const cached = cache.get(cacheKey);
      if (cached !== undefined) {
        // Cache hit: costs nothing against the sliding time budget
        codeHtml = cached;
      } else {
        const currentTime = now();
        const spent = getSpentTime(currentTime);
        if (spent >= maxBudgetMs) {
          // Budget exhausted: fall back to plain escaped text, do NOT cache
          codeHtml = escapeHtml(codeString);
        } else {
          const t0 = now();
          try {
            const highlighted = highlight(codeString, resolved.canonical);
            codeHtml = typeof highlighted === 'string' ? highlighted : escapeHtml(codeString);
          } catch {
            codeHtml = escapeHtml(codeString);
          }
          const t1 = now();
          const duration = Math.max(0, t1 - t0);
          budgetEntries.push({ timestamp: t0, duration });
          cache.set(cacheKey, codeHtml);
        }
      }
    }

    const headerContent = resolved
      ? `<span class="fenced-code-block-lang" data-lang="${escapeAttribute(resolved.label)}"></span><button type="button" class="fenced-code-block-copy" data-code-copy aria-label="Copy code"></button>`
      : `<button type="button" class="fenced-code-block-copy" data-code-copy aria-label="Copy code"></button>`;

    const langClass = resolved ? ` language-${escapeAttribute(resolved.label)}` : '';

    return `<div class="fenced-code-block"><div class="fenced-code-block-header">${headerContent}</div><pre><code class="fenced-code-block-content${langClass}">${codeHtml}</code></pre></div>`;
  }

  return {
    renderCodeBlock,
    cache,
    resolveLanguage,
  };
}

export async function executeCodeBlockCopy(button, textToCopy, copyFn, copyTimers = new WeakMap()) {
  let success = false;
  if (textToCopy !== null && typeof textToCopy === 'string') {
    try {
      success = Boolean(await copyFn(textToCopy));
    } catch {
      success = false;
    }
  }

  // Clear previous timer AFTER the await to avoid timer races on rapid clicks
  const prevTimer = copyTimers.get(button);
  if (prevTimer !== undefined) {
    clearTimeout(prevTimer);
    copyTimers.delete(button);
  }

  if (!button.isConnected) return { success, timerId: null };

  if (success) {
    button.setAttribute('data-copied', 'true');
    button.setAttribute('aria-label', 'Copied to clipboard');
  } else {
    button.setAttribute('data-copied', 'error');
    button.setAttribute('aria-label', 'Failed to copy to clipboard');
  }

  const timerId = setTimeout(() => {
    if (copyTimers.get(button) === timerId) {
      copyTimers.delete(button);
    }
    if (button.isConnected) {
      button.removeAttribute('data-copied');
      button.setAttribute('aria-label', 'Copy code');
    }
  }, 2000);

  copyTimers.set(button, timerId);
  return { success, timerId };
}

export function setupCodeBlockCopyListener(copyFn) {
  if (typeof document === 'undefined') return () => {};

  const copyTimers = new WeakMap();

  async function handleCopyClick(event) {
    const target = event?.target;
    const button = target && typeof target.closest === 'function' ? target.closest('[data-code-copy]') : null;
    if (!button) return;

    // Prevent default button actions, but do NOT stop propagation so outside-click
    // listeners (e.g. popover dismissal) still see the event.
    event.preventDefault();

    const container = button.closest('.fenced-code-block');
    const codeEl = container?.querySelector('pre code.fenced-code-block-content') || container?.querySelector('code');
    if (!codeEl) {
      await executeCodeBlockCopy(button, null, copyFn, copyTimers);
      return;
    }

    const textToCopy = codeEl.textContent ?? '';
    await executeCodeBlockCopy(button, textToCopy, copyFn, copyTimers);
  }

  document.addEventListener('click', handleCopyClick, true);
  return () => {
    document.removeEventListener('click', handleCopyClick, true);
  };
}
