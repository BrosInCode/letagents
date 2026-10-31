import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { renderToString } from "@vue/server-renderer";
import { createSSRApp, defineComponent, h } from "vue";
import { createServer, type ViteDevServer } from "vite";

let vite: ViteDevServer;
let DesktopSwitch: { setup: (props: Record<string, unknown>, context: Record<string, unknown>) => Record<string, unknown> };

before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL("../..", import.meta.url)),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  DesktopSwitch = (await vite.ssrLoadModule("/renderer/src/components/desktop/controls/DesktopSwitch.vue")).default;
});

after(async () => {
  await vite?.close();
});

const render = (props: Record<string, unknown>) => renderToString(createSSRApp(DesktopSwitch as never, props));

/**
 * Presses the switch as a click would, and reports whether it asked its owner
 * for a change. The switch's setup runs inside a render, where Vue provides
 * the context it needs.
 */
async function press(props: { checked: boolean; busy?: boolean; disabled?: boolean }): Promise<boolean> {
  let asked = false;
  await renderToString(createSSRApp(defineComponent({
    setup() {
      const bindings = DesktopSwitch.setup(props, {
        emit: (event: string) => { if (event === "toggle") asked = true; },
        expose: () => undefined, attrs: {}, slots: {},
      });
      (bindings.toggle as () => void)();
      return () => h("div");
    },
  })));
  return asked;
}

test("the switch says whether it is on", async () => {
  assert.match(await render({ checked: true, label: "Sound effects" }), /role="switch" aria-checked="true" aria-label="Sound effects"/);
  assert.match(await render({ checked: false, label: "Sound effects" }), /aria-checked="false"/);
});

test("it is named and described by the row it sits in", async () => {
  const html = await render({ checked: true, labelledby: "row-title", describedby: "row-description" });
  assert.match(html, /aria-labelledby="row-title"/);
  assert.match(html, /aria-describedby="row-description"/);
});

test("a switch that is saving keeps focus and does not answer", async () => {
  const html = await render({ checked: true, label: "Routing", busy: true });
  assert.match(html, /aria-disabled="true"/);
  assert.doesNotMatch(html, / disabled/, "a disabled button would drop focus mid-save");
  assert.equal(await press({ checked: true, busy: true }), false);
});

test("only a switch that can never be changed is disabled", async () => {
  const html = await render({ checked: false, label: "Desktop notifications", disabled: true });
  assert.match(html, / disabled/);
  assert.doesNotMatch(html, /aria-disabled/);
  assert.equal(await press({ checked: false, disabled: true }), false);
});

test("a press asks the owner to change it, whichever way it is set", async () => {
  assert.equal(await press({ checked: false }), true);
  assert.equal(await press({ checked: true }), true);
});
