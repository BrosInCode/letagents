import assert from "node:assert/strict";
import { describe, it, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createRenderer, h, markRaw, nextTick, reactive, ssrContextKey } from "vue";
import { createServer } from "vite";

import {
  focusFirstElementInDialog,
  trapFocusInDialog,
} from "../src/components/desktop/content/modal-focus";

describe("modal focus helpers", () => {
  it("focuses the first available control instead of the dialog root", () => {
    withFakeDom(({ dialog, firstControl, document }) => {
      focusFirstElementInDialog(dialog as unknown as HTMLElement);

      assert.equal(document.activeElement, firstControl);
    });
  });

  it("keeps reverse tabbing inside when the dialog root owns focus", () => {
    withFakeDom(({ dialog, lastControl, document }) => {
      document.activeElement = dialog;
      let prevented = false;

      trapFocusInDialog({
        shiftKey: true,
        preventDefault: () => {
          prevented = true;
        },
      } as KeyboardEvent, dialog as unknown as HTMLElement);

      assert.equal(prevented, true);
      assert.equal(document.activeElement, lastControl);
    });
  });

  it("wraps from the last visible control when a collapsed section hides later buttons", () => {
    withFakeDom(({ dialog, firstControl, lastControl, document }) => {
      lastControl.visible = false;
      document.activeElement = firstControl;
      let prevented = false;

      trapFocusInDialog({
        shiftKey: false,
        preventDefault: () => { prevented = true; },
      } as KeyboardEvent, dialog as unknown as HTMLElement);

      assert.equal(prevented, true);
      assert.equal(document.activeElement, firstControl);
    });
  });
});

interface FakeDom {
  dialog: FakeElement;
  firstControl: FakeElement;
  lastControl: FakeElement;
  document: FakeDocument;
}

function withFakeDom(callback: (dom: FakeDom) => void): void {
  const elementDescriptor = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  const document = new FakeDocument();
  FakeElement.document = document;
  Object.defineProperty(globalThis, "HTMLElement", {
    configurable: true,
    value: FakeElement,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: document,
  });

  const firstControl = new FakeElement();
  const lastControl = new FakeElement();
  const dialog = new FakeElement([firstControl, lastControl]);
  document.nodes = [dialog, firstControl, lastControl];

  try {
    callback({ dialog, firstControl, lastControl, document });
  } finally {
    restoreGlobal("HTMLElement", elementDescriptor);
    restoreGlobal("document", documentDescriptor);
  }
}

function restoreGlobal(
  key: "HTMLElement" | "document",
  descriptor: PropertyDescriptor | undefined
): void {
  if (descriptor) Object.defineProperty(globalThis, key, descriptor);
  else Reflect.deleteProperty(globalThis, key);
}

class FakeDocument {
  activeElement: FakeElement | null = null;
  nodes: FakeElement[] = [];

  contains(element: FakeElement): boolean {
    return this.nodes.includes(element);
  }
}

class FakeElement {
  static document: FakeDocument;
  visible = true;
  disabled = false;

  constructor(private readonly controls: FakeElement[] = []) {}

  contains(element: FakeElement): boolean {
    return element === this || this.controls.includes(element);
  }

  focus(): void {
    FakeElement.document.activeElement = this;
  }

  getAttribute(): string | null {
    return null;
  }

  getClientRects(): object[] {
    return [{}];
  }

  checkVisibility(): boolean {
    return this.visible;
  }

  hasAttribute(): boolean {
    return this.disabled;
  }

  closest(): null { return null; }
  matches(): boolean { return this.disabled; }
  querySelector(): FakeElement | undefined { return this.controls.find(control => !control.disabled); }

  querySelectorAll(): FakeElement[] {
    return this.controls;
  }
}

test("room creation keeps focus trapped when its form is replaced or disabled while pending", async () => {
  const vite = await createServer({ root: fileURLToPath(new URL("../..", import.meta.url)), appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  let Modal: any;
  try { Modal = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/DesktopNewRoomModal.vue")).default; }
  finally { await vite.close(); }
  const elementDescriptor = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  const document = new FakeDocument();
  FakeElement.document = document;
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: FakeElement });
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  const submit = markRaw(new FakeElement()), outside = markRaw(new FakeElement()), dialog = markRaw(new FakeElement([submit]));
  document.nodes = [dialog, submit, outside];
  document.activeElement = outside;
  const props = reactive({ step: "standalone", busy: false, canDismiss: true, activeAction: null,
    feedback: null, feedbackState: "info", projectSelection: null, projectPathError: null, projectCreationError: null,
    recentProjectFolders: [], success: null, statusMessage: null, joinError: null, canSubmitJoin: true,
    canSubmitStandalone: true, joinCode: "", roomName: "Planning", storage: "cloud", projectPath: "", projectName: "", projectParent: "" });
  let vm: any;
  const Probe = { ...Modal, setup(input: any, context: any) { vm = Modal.setup(input, context); return vm; }, render: () => h("div") };
  const renderer = createRenderer<any, any>({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null });
  const app = renderer.createApp({ render: () => h(Probe, props) });
  app.provide(ssrContextKey, { modules: new Set() });
  const settle = async () => { await nextTick(); await nextTick(); };
  try {
    app.mount({}); vm.dialogElement.value = dialog; await settle();
    document.activeElement = submit;
    props.step = "working"; props.busy = true; props.canDismiss = false;
    submit.disabled = true;
    document.activeElement = outside; // The browser drops focus as the old form is removed.
    await settle();
    assert.equal(document.activeElement, dialog);
    for (const shiftKey of [false, true]) {
      let prevented = false;
      vm.handleDialogTab({ shiftKey, preventDefault() { prevented = true; } });
      assert.equal(prevented, true, "Tab cannot move into the room behind an all-disabled dialog");
      assert.equal(document.activeElement, dialog);
    }
    props.step = "new_project"; props.busy = false; props.canDismiss = true; submit.disabled = false;
    await settle(); assert.equal(document.activeElement, submit);
    props.busy = true; submit.disabled = true; await settle();
    assert.equal(document.activeElement, dialog, "pending project creation also retains focus when its form stays mounted");
  } finally {
    app.unmount();
    assert.equal(document.activeElement, outside, "dismissal restores the original trigger");
    restoreGlobal("HTMLElement", elementDescriptor); restoreGlobal("document", documentDescriptor);
  }
});
