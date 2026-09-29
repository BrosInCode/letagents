/** Compact public prose without leaking machine paths or cutting a sentence in half. */
export function readableContributionText(value, limit = 400) {
  if (!value?.trim()) return null;
  // A legacy 400-character value may already be cut. Never present its trailing fragment.
  const possiblyCut = value.length >= limit;
  const links = [];
  const protect = text => {
    const markdown = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(text);
    const target = markdown?.[2] ?? text;
    const file = /^https?:\/\/(?:github\.com\/[^/]+\/[^/]+\/(?:blob|raw)|raw\.githubusercontent\.com\/[^/]+\/[^/]+)\/[^/]+\/(.+?)(?:[?#].*)?$/.exec(target);
    const name = file?.[1].split('/').at(-1);
    const punctuation = !markdown ? name?.match(/[.,;:!?]+$/)?.[0] ?? '' : '';
    const label = name ? '`' + name.slice(0, name.length - punctuation.length) + '`' + punctuation : markdown?.[1] ?? text;
    return '\u0000LINK' + (links.push(label) - 1) + '\u0000';
  };
  const source = value.replace(/\u0000/g, '').replace(/\[[^\]\n]+\]\(https?:\/\/[^)]+\)|https?:\/\/[^\s<>]+/g, protect);
  let text = source.replace(/\[([^\]\n]+)\]\((<[^>]+>|[^)]+)\)/g, (match, label, target) => /^https?:\/\//.test(target) ? match : '`' + label.split(/[\\/]/).at(-1) + '`')
    .replace(/(?:file:\/\/)?(?:\/[A-Za-z0-9_.~ -]+)+\/([^\s`<>\[\]()]+)|[A-Za-z]:\\(?:[^\s\\]+\\)+([^\s`<>]+)|(?:\.\.?\/)(?:[^\s/]+\/)*([^\s`<>]+)/g,
      (_match, unix, windows, relative) => '`' + (unix || windows || relative) + '`')
    .replace(/(?<!`)``([^`\n]+)``(?!`)/g, '`$1`')
    .replace(/^\s*(?:Done\.?|Path:\s*`[^`]+`)\s*$/gmi, '')
    .trim();
  text = text.replace(/\u0000LINK(\d+)\u0000/g, (_match, index) => links[Number(index)] ?? '');
  if (!text) return null;
  if (text.length > limit || possiblyCut) {
    const prefix = text.slice(0, limit);
    // Keep complete paragraphs or sentences only; a file list below remains the grounded fallback.
    const end = [...prefix.matchAll(/(?<![.!?])[.!?](?=\s|$)/g)].at(-1);
    if (!end) return null;
    text = prefix.slice(0, end.index + 1).trim();
    if ((text.match(/```/g)?.length ?? 0) % 2) text = text.slice(0, text.lastIndexOf('```')).trim();
  }
  return /^Done[.!]?$/i.test(text) ? null : text || null;
}
