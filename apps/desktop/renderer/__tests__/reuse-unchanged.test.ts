import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { reuseUnchanged } from "../src/domain/reuse-unchanged";

describe("reuseUnchanged", () => {
  it("returns the previous object when everything is equal", () => {
    const previous = { a: 1, list: [{ id: "x", tags: ["t"] }], nested: { deep: { v: null } } };
    const next = structuredClone(previous);
    assert.equal(reuseUnchanged(previous, next), previous);
  });

  it("gives a changed child a new identity and reuses its unchanged siblings", () => {
    const previous = { left: { n: 1 }, right: { n: 2 }, list: [{ id: 1 }, { id: 2 }] };
    const next = { left: { n: 1 }, right: { n: 3 }, list: [{ id: 1 }, { id: 2 }] };
    const result = reuseUnchanged(previous, next);
    assert.notEqual(result, previous);
    assert.deepEqual(result, next);
    assert.equal(result.left, previous.left);
    assert.equal(result.list, previous.list);
    assert.notEqual(result.right, previous.right);
  });

  it("reuses array elements one by one", () => {
    const previous = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const result = reuseUnchanged(previous, [{ id: 1 }, { id: 9 }, { id: 3 }]);
    assert.notEqual(result, previous);
    assert.equal(result[0], previous[0]);
    assert.notEqual(result[1], previous[1]);
    assert.equal(result[2], previous[2]);
  });

  it("treats a longer, shorter or reordered array as changed", () => {
    const previous = [{ id: 1 }, { id: 2 }];
    assert.notEqual(reuseUnchanged(previous, [{ id: 1 }]), previous);
    const longer = reuseUnchanged(previous, [{ id: 1 }, { id: 2 }, { id: 3 }]);
    assert.equal(longer.length, 3);
    assert.equal(longer[0], previous[0]);
    const swapped = reuseUnchanged(previous, [{ id: 2 }, { id: 1 }]);
    assert.deepEqual(swapped, [{ id: 2 }, { id: 1 }]);
    assert.notEqual(swapped, previous);
  });

  it("detects added and removed object keys", () => {
    const previous: Record<string, unknown> = { a: 1, b: 2 };
    assert.notEqual(reuseUnchanged(previous, { a: 1 }), previous);
    assert.notEqual(reuseUnchanged(previous, { a: 1, b: 2, c: 3 }), previous);
    assert.deepEqual(reuseUnchanged(previous, { a: 1, c: 2 }), { a: 1, c: 2 });
  });

  it("handles null, undefined and primitives", () => {
    assert.equal(reuseUnchanged(null, null), null);
    assert.deepEqual(reuseUnchanged<unknown>(null, { a: 1 }), { a: 1 });
    assert.equal(reuseUnchanged<unknown>({ a: 1 }, null), null);
    assert.equal(reuseUnchanged<unknown>(undefined, 3), 3);
    assert.equal(reuseUnchanged(1, 2), 2);
    assert.equal(reuseUnchanged("a", "a"), "a");
    assert.equal(Array.isArray(reuseUnchanged<unknown>([], {})), false);
    const empty: unknown[] = [];
    assert.equal(reuseUnchanged(empty, []), empty);
  });

  it("does not treat a different key order as a change", () => {
    const previous = { a: 1, b: 2 };
    assert.equal(reuseUnchanged(previous, { b: 2, a: 1 }), previous);
  });
});
