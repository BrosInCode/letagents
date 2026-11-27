import assert from "node:assert/strict";
import test from "node:test";
import postcss from "postcss";

import { surfaceGroup, surfaceTexture } from "../../surface-texture.postcss";

test("a surface colour token picks its texture group", () => {
  assert.equal(surfaceGroup("var(--bg)"), "background");
  assert.equal(surfaceGroup("var(--board-card)"), "cards");
  assert.equal(surfaceGroup("var(--workspace-composer, var(--bg-card))"), "composer");
  assert.equal(surfaceGroup("color-mix(in srgb, var(--blue) 5%, var(--bg-elevated))"), "menus");
});

test("translucent, layered and see-through paint gets no grain", () => {
  assert.equal(surfaceGroup("transparent"), null);
  assert.equal(surfaceGroup("rgba(255, 255, 255, 0.05)", ".desktop-context-menu"), null);
  assert.equal(surfaceGroup("color-mix(in srgb, var(--text) 10%, transparent)"), null);
  assert.equal(surfaceGroup("linear-gradient(var(--bg), var(--bg-subtle))"), null);
  assert.equal(surfaceGroup("var(--bg-subtle) url(tile.png)"), null);
  assert.equal(surfaceGroup("var(--workspace-canvas, var(--bg))"), null, "the room canvas is see-through in texture mode");
});

test("a fixed opaque colour counts only on a floating surface", () => {
  assert.equal(surfaceGroup("light-dark(#fff,#161616)", ".board-options-menu"), "menus");
  assert.equal(surfaceGroup("light-dark(#fff,#161616)", ".board-lane"), null);
  assert.equal(surfaceGroup("#0006", ".board-dialog"), null, "a translucent hex is not opaque");
});

test("the build step adds the group image right after the paint", async () => {
  const input = [
    ".card { background: var(--bg-subtle); color: red }",
    ".card:hover { background-color: transparent }",
    ".menu::-webkit-scrollbar { background: var(--bg-elevated) }",
    "@keyframes flash { from { background: var(--bg) } }",
  ].join("\n");
  const { css } = await postcss([surfaceTexture()]).process(input, { from: undefined });
  assert.match(css, /\.card \{ background: var\(--bg-subtle\); background-image: var\(--grain-cards, none\); color: red \}/);
  assert.equal(css.match(/background-image/g)?.length, 1);
});
