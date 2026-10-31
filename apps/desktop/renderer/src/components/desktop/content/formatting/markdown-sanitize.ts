import DOMPurify, { type Config, type DOMPurify as Purifier } from "dompurify";

// The Markdown renderer escapes all message text itself. This pass is a second
// guard: it keeps only the elements and attributes that renderer emits.
export const MARKDOWN_ALLOWED_TAGS = [
  "a", "blockquote", "br", "button", "code", "del", "div", "em", "h1", "h2", "h3", "h4", "h5", "h6",
  "hr", "input", "li", "mark", "ol", "p", "pre", "span", "strong", "table", "tbody", "td", "th",
  "thead", "tr", "ul",
] as const;

export const MARKDOWN_ALLOWED_ATTRIBUTES = [
  "aria-label", "checked", "class", "data-code-copy", "data-lang", "disabled", "href", "rel", "start",
  "target", "type",
] as const;

const CONFIG: Config = {
  ALLOWED_TAGS: [...MARKDOWN_ALLOWED_TAGS],
  ALLOWED_ATTR: [...MARKDOWN_ALLOWED_ATTRIBUTES],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  // ALLOWED_URI_REGEXP would also test every non-URI attribute value (type,
  // start, data-lang), so the http(s)-only link rule lives in the hook below.
  FORBID_ATTR: ["style"],
};

let purifier: Purifier | null = null;

function getPurifier(): Purifier | null {
  if (purifier) return purifier;
  // DOMPurify needs a real DOM. Renderer unit tests run in Node without one (or
  // with a stub window); there the renderer's own escaping is the only guard and
  // the HTML passes unchanged.
  if (typeof window === "undefined" || !window.document) return null;
  const instance = DOMPurify(window);
  if (!instance.isSupported) return null;
  instance.addHook("afterSanitizeAttributes", (node) => {
    const element = node as Element;
    const tag = element.tagName?.toLowerCase();
    if (tag === "a") {
      if (!/^https?:\/\//i.test(element.getAttribute("href") ?? "")) element.removeAttribute("href");
      element.setAttribute("target", "_blank");
      element.setAttribute("rel", "noopener noreferrer");
    } else if (tag === "input") {
      if (element.getAttribute("type") !== "checkbox") {
        element.remove();
        return;
      }
      element.setAttribute("disabled", "");
    } else if (tag === "button") {
      element.setAttribute("type", "button");
    }
  });
  return (purifier = instance);
}

export function sanitizeMarkdownHtml(html: string): string {
  const instance = getPurifier();
  return instance ? instance.sanitize(html, CONFIG) : html;
}
