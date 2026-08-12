import assert from "node:assert/strict";
import { describe, it } from "node:test";

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

  hasAttribute(): boolean {
    return false;
  }

  querySelectorAll(): FakeElement[] {
    return this.controls;
  }
}
