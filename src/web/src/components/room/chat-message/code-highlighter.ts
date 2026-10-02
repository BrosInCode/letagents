import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import python from 'highlight.js/lib/languages/python'
import bash from 'highlight.js/lib/languages/bash'
import json from 'highlight.js/lib/languages/json'
import yaml from 'highlight.js/lib/languages/yaml'
import xml from 'highlight.js/lib/languages/xml'
import css from 'highlight.js/lib/languages/css'
import sql from 'highlight.js/lib/languages/sql'
import diff from 'highlight.js/lib/languages/diff'
import rust from 'highlight.js/lib/languages/rust'
import go from 'highlight.js/lib/languages/go'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import java from 'highlight.js/lib/languages/java'
import csharp from 'highlight.js/lib/languages/csharp'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import ruby from 'highlight.js/lib/languages/ruby'
import php from 'highlight.js/lib/languages/php'
import swift from 'highlight.js/lib/languages/swift'
import kotlin from 'highlight.js/lib/languages/kotlin'
import ini from 'highlight.js/lib/languages/ini'

import type { LanguageFn } from 'highlight.js'
import {
  createCodeHighlighter,
  type CanonicalLanguage,
  type CodeHighlighter,
} from '../../../../../../shared/code-highlighting.mjs'

const languages: Record<CanonicalLanguage, LanguageFn> = {
  javascript,
  typescript,
  python,
  bash,
  json,
  yaml,
  xml,
  css,
  sql,
  diff,
  rust,
  go,
  c,
  cpp,
  java,
  csharp,
  dockerfile,
  ruby,
  php,
  swift,
  kotlin,
  ini,
}

for (const [name, language] of Object.entries(languages)) {
  hljs.registerLanguage(name, language)
}

export const webHighlighter: CodeHighlighter = createCodeHighlighter({
  highlight(code: string, canonicalLanguage: CanonicalLanguage): string {
    return hljs.highlight(code, { language: canonicalLanguage, ignoreIllegals: true }).value
  },
})
