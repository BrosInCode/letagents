import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "@vue/compiler-sfc";
import ts from "typescript";
import { createServer } from "vite";
import { createRenderer, ssrContextKey } from "vue";

// App.vue fills one shared context in order: each composable reads the names it
// needs at once from the context, and later names only through `app.` inside
// functions that run after setup. These checks keep that order honest, because
// the context type itself does not encode it.

const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
const composablesRoot = `${sourceRoot}composables/app/`;

function exportedComposables(): Map<string, { reads: string[]; returns: string[] }> {
  const result = new Map<string, { reads: string[]; returns: string[] }>();
  for (const name of readdirSync(composablesRoot).filter((file) => file.endsWith(".ts"))) {
    const file = ts.createSourceFile(name, readFileSync(`${composablesRoot}${name}`, "utf8"), ts.ScriptTarget.Latest, true);
    for (const statement of file.statements) {
      if (!ts.isFunctionDeclaration(statement) || !statement.name || !statement.body) continue;
      const reads: string[] = [];
      const returns: string[] = [];
      for (const inner of statement.body.statements) {
        // `const { a, b } = context as AppContextOf<...>` (or `= app`): names read at once.
        if (ts.isVariableStatement(inner)) {
          const declaration = inner.declarationList.declarations[0]!;
          const initializer = declaration.initializer;
          const fromContext = initializer && (
            (ts.isAsExpression(initializer) && initializer.expression.getText(file) === "context")
            || (ts.isIdentifier(initializer) && initializer.text === "app"));
          if (fromContext && ts.isObjectBindingPattern(declaration.name)) {
            for (const element of declaration.name.elements) reads.push((element.propertyName ?? element.name).getText(file));
          }
        }
        if (ts.isReturnStatement(inner) && inner.expression && ts.isObjectLiteralExpression(inner.expression)) {
          for (const property of inner.expression.properties) if (property.name) returns.push(property.name.getText(file));
        }
      }
      result.set(statement.name.text, { reads, returns });
    }
  }
  return result;
}

test("each App.vue composable reads at once only names that earlier composables published", () => {
  const script = parse(readFileSync(`${sourceRoot}App.vue`, "utf8")).descriptor.scriptSetup!.content;
  const calls = [...script.matchAll(/Object\.assign\(app, (useApp\w+)\(/g)].map((match) => match[1]!);
  const composables = exportedComposables();
  assert.ok(calls.length > 10, "App.vue fills the context from its composables");
  const published = new Set<string>();
  for (const call of calls) {
    const composable = composables.get(call);
    assert.ok(composable, `${call} is defined in composables/app/`);
    for (const name of composable.reads) {
      assert.ok(published.has(name), `${call} reads ${name} before any earlier composable published it`);
    }
    for (const name of composable.returns) published.add(name);
  }
});

test("App.vue mounts and unmounts with a stub desktop bridge without an error", async () => {
  const stubCalls: string[] = [];
  // Subscriptions (onX) hand back an unsubscribe function; every other call resolves empty.
  const method = (path: string) => new Proxy(function () {}, {
    apply: () => { stubCalls.push(path); return /\.on[A-Z]/.test(path) ? () => {} : Promise.resolve(undefined); },
  });
  const namespace = (path: string) => new Proxy({}, {
    get: (_target, key) => (typeof key === "symbol" || key === "then" ? undefined : method(`${path}.${String(key)}`)),
    has: () => true,
  });
  const bridge = new Proxy({}, {
    get: (_target, key) => (typeof key === "symbol" || key === "then" ? undefined : namespace(String(key))),
    has: () => true,
  });
  const storage = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  };
  const element = () => ({ style: {}, setAttribute() {}, appendChild() {}, content: {}, classList: { add() {}, remove() {} } });
  const globals = globalThis as Record<string, unknown>;
  const previous = { window: globals.window, document: globals.document, localStorage: globals.localStorage };
  const onUnhandled = () => {};
  process.on("unhandledRejection", onUnhandled);
  Object.assign(globals, {
    window: Object.assign(new EventTarget(), {
      letagentsDesktop: bridge, localStorage,
      setInterval: () => 1, clearInterval: () => {}, setTimeout, clearTimeout,
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    }),
    document: {
      hasFocus: () => true, hidden: false, visibilityState: "visible",
      addEventListener() {}, removeEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
      documentElement: { style: {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, dataset: {} },
      body: { style: {}, appendChild() {}, classList: { add() {}, remove() {} } }, head: { appendChild() {} },
      createElement: element, createElementNS: element, createTextNode: () => ({}), createComment: () => ({}),
    },
    localStorage,
  });
  const vite = await createServer({ root: fileURLToPath(new URL("../..", import.meta.url)), appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  try {
    const App = (await vite.ssrLoadModule("/renderer/src/App.vue")).default;
    const errors: string[] = [];
    const renderer = createRenderer<any, any>({
      patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
      setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null, setScopeId() {}, cloneNode: (node: unknown) => node,
    });
    const app = renderer.createApp(App);
    app.provide(ssrContextKey, { modules: new Set() });
    app.config.errorHandler = (error, _instance, info) => { errors.push(`${info}: ${error instanceof Error ? error.message : String(error)}`); };
    app.config.warnHandler = () => {};
    app.mount({});
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(errors, [], "setup and mount finish without an error");
    assert.ok(stubCalls.includes("room.getNeedsYou") && stubCalls.includes("auth.getStatus"), "the mounted app talks to the bridge");
    app.unmount();
    assert.deepEqual(errors, [], "unmount finishes without an error");
  } finally {
    await vite.close();
    process.off("unhandledRejection", onUnhandled);
    Object.assign(globals, previous);
  }
});
