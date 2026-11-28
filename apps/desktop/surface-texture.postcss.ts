import type { Declaration, Plugin } from "postcss";

/**
 * Lets every surface in the renderer carry the film grain, without a list of
 * class names to keep up to date.
 *
 * The app paints its surfaces with a few colour tokens. For each `background`
 * or `background-color` that paints one of them (opaque, one layer), this adds
 * `background-image: var(--grain-<group>, none)` right after it, in the same
 * rule. app-texture.css sets `--grain-<group>` to the grain tile when the
 * person turns that group on (Settings → Styling); otherwise it is unset and
 * the image is `none`. A new component that uses the tokens is covered too.
 *
 * See-through surfaces count too, such as a menu that mixes --bg-elevated
 * with transparent and blurs what is behind it: "All" means every surface.
 * Left alone: tints with no surface token (hover and selection overlays on a
 * surface that already has the grain), gradients and images, several layers,
 * and the room theme's canvas and sidebar, which app-texture.css makes
 * see-through.
 */
export const SURFACE_TOKEN_GROUPS: Readonly<Record<string, string>> = {
  "--bg": "background",
  "--setup-bg": "background",
  "--bg-subtle": "cards",
  "--bg-card": "cards",
  "--setup-surface": "cards",
  "--setup-surface-muted": "cards",
  "--code-bg": "cards",
  "--code-header-bg": "cards",
  "--bg-elevated": "menus",
  // The shared task board (shared/ui/board) has its own scale.
  "--board-bg": "background",
  "--board-well": "cards",
  "--board-card": "cards",
  "--board-hover": "cards",
  "--chat-bubble": "bubbles",
  "--chat-bubble-start": "bubbles",
  "--workspace-composer": "composer",
};

/**
 * Some menus and dialogs are painted with a fixed colour, not a token. An
 * opaque fixed colour in a rule whose selector names a floating surface joins
 * the menus group.
 */
const FIXED_OPAQUE = /^(#[\da-f]{3}|#[\da-f]{6}|light-dark\(\s*#[\da-f]{3,6}\s*,\s*#[\da-f]{3,6}\s*\))$/i;
const FLOATING_SELECTOR = /menu|popover|dialog|modal|toast|tooltip|dropdown|picker|sheet/i;

const SEE_THROUGH_TOKENS = new Set(["--workspace-canvas", "--workspace-sidebar"]);
const SKIP_VALUE = /gradient\(|url\(|image-set\(/i;
const SKIP_SELECTOR = /::(-webkit-|selection|placeholder|backdrop|marker)/;

/** The group that paints this value, or null when it is not a plain surface. */
export function surfaceGroup(value: string, selector = ""): string | null {
  if (SKIP_VALUE.test(value) || hasTopLevelComma(value)) return null;
  for (const [, token] of value.matchAll(/var\(\s*(--[\w-]+)/g)) {
    if (SEE_THROUGH_TOKENS.has(token)) return null;
    const group = SURFACE_TOKEN_GROUPS[token];
    if (group) return group;
  }
  return FIXED_OPAQUE.test(value.trim()) && FLOATING_SELECTOR.test(selector) ? "menus" : null;
}

function hasTopLevelComma(value: string): boolean {
  let depth = 0;
  for (const char of value) {
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) return true;
  }
  return false;
}

function inKeyframes(declaration: Declaration): boolean {
  for (let node: { type: string; parent?: unknown } | undefined = declaration.parent; node;
    node = node.parent as { type: string; parent?: unknown } | undefined) {
    if (node.type === "atrule" && /keyframes$/i.test((node as unknown as { name: string }).name)) return true;
  }
  return false;
}

export function surfaceTexture(): Plugin {
  return {
    postcssPlugin: "letagents-surface-texture",
    Declaration(declaration) {
      if (declaration.prop !== "background" && declaration.prop !== "background-color") return;
      const rule = declaration.parent;
      if (!rule || rule.type !== "rule" || inKeyframes(declaration)) return;
      const selector = (rule as { selector: string }).selector;
      if (SKIP_SELECTOR.test(selector)) return;
      const group = surfaceGroup(declaration.value, selector);
      if (!group) return;
      const image = `var(--grain-${group}, none)`;
      const next = declaration.next();
      if (next?.type === "decl" && next.prop === "background-image" && next.value === image) return;
      declaration.after({ prop: "background-image", value: image, important: declaration.important });
    },
  };
}
surfaceTexture.postcss = true as const;
