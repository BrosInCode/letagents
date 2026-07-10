import assert from "node:assert/strict";
import test from "node:test";

import { copyTextToClipboard } from "../src/domain/clipboard";
import { useCopyIndicator, useCopyValueIndicator } from "../src/composables/useCopyIndicator";

function withGlobal<T>(name: "navigator" | "window", value: unknown, run: () => Promise<T>): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  return run().finally(() => {
    if (previous) {
      Object.defineProperty(globalThis, name, previous);
    } else {
      delete (globalThis as Record<string, unknown>)[name];
    }
  });
}

function fakeWindow(): { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } {
  return {
    setTimeout: globalThis.setTimeout.bind(globalThis) as typeof setTimeout,
    clearTimeout: globalThis.clearTimeout.bind(globalThis) as typeof clearTimeout,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

test("copyTextToClipboard returns false when clipboard is unavailable", async () => {
  await withGlobal("navigator", {}, async () => {
    assert.equal(await copyTextToClipboard("hello"), false);
  });
});

test("copyTextToClipboard writes text and returns true", async () => {
  const written: string[] = [];
  await withGlobal("navigator", {
    clipboard: {
      writeText: async (value: string) => {
        written.push(value);
      },
    },
  }, async () => {
    assert.equal(await copyTextToClipboard("hello"), true);
  });
  assert.deepEqual(written, ["hello"]);
});

test("copyTextToClipboard returns false when writeText rejects", async () => {
  await withGlobal("navigator", {
    clipboard: {
      writeText: async () => {
        throw new Error("denied");
      },
    },
  }, async () => {
    assert.equal(await copyTextToClipboard("hello"), false);
  });
});

test("useCopyIndicator sets copied and resets after the timeout", async () => {
  await withGlobal("navigator", {
    clipboard: { writeText: async () => undefined },
  }, () => withGlobal("window", fakeWindow(), async () => {
    const { copied, copy } = useCopyIndicator(10);
    assert.equal(copied.value, false);
    assert.equal(await copy("text"), true);
    assert.equal(copied.value, true);
    await sleep(30);
    assert.equal(copied.value, false);
  }));
});

test("useCopyIndicator leaves copied false on failure", async () => {
  await withGlobal("navigator", {}, () => withGlobal("window", fakeWindow(), async () => {
    const { copied, copy } = useCopyIndicator(10);
    assert.equal(await copy("text"), false);
    assert.equal(copied.value, false);
  }));
});

test("useCopyValueIndicator tracks the copied value and resets", async () => {
  await withGlobal("navigator", {
    clipboard: { writeText: async () => undefined },
  }, () => withGlobal("window", fakeWindow(), async () => {
    const { copiedValue, copy } = useCopyValueIndicator(10);
    assert.equal(copiedValue.value, null);
    assert.equal(await copy("first"), true);
    assert.equal(copiedValue.value, "first");
    assert.equal(await copy("second"), true);
    assert.equal(copiedValue.value, "second");
    await sleep(30);
    assert.equal(copiedValue.value, null);
  }));
});
