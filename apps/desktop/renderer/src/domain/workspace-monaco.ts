import * as monaco from 'monaco-editor/editor/editor.api';
import 'monaco-editor/basic-languages/monaco.contribution';
import { jsonDefaults } from 'monaco-editor/languages/features/json/register';
import 'monaco-editor/editor/contrib/find/browser/findController';
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching';
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker&inline';

// A bundled blob worker also works in Electron's packaged file:// renderer.
globalThis.MonacoEnvironment = { getWorker: () => new EditorWorker() };
// Captured JSON needs highlighting only, without validation of partial hunks.
jsonDefaults.setModeConfiguration({ tokens: true });

export function workspaceLanguage(path: string): string {
  const name = path.split('/').at(-1)!.toLowerCase();
  if (name.endsWith('.vue')) return 'html';
  return monaco.languages.getLanguages().find(language =>
    language.filenames?.some(filename => filename.toLowerCase() === name)
    || language.extensions?.some(extension => name.endsWith(extension.toLowerCase())),
  )?.id ?? 'plaintext';
}

export { monaco };
