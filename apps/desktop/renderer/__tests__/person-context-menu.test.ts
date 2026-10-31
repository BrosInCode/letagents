import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildPersonContextMenuItems, personMenuPosition } from "../src/domain/person-context-menu";
import type { PersonTarget } from "../src/domain/person-target";

const ana: PersonTarget = { login: "Ana-Lee", displayName: "Ana Lee", avatarUrl: null };

describe("buildPersonContextMenuItems", () => {
  it("returns one group with Message and Work in this room", () => {
    const groups = buildPersonContextMenuItems({ target: ana, viewerLogin: "someone-else" });
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0]!.map((item) => [item.id, item.label]), [
      ["message", "Message Ana Lee"],
      ["work", "Work in this room"],
    ]);
  });

  it("keeps Message enabled for another person", () => {
    const [group] = buildPersonContextMenuItems({ target: ana, viewerLogin: "someone-else" });
    assert.equal(group!.find((item) => item.id === "message")!.disabled, false);
    assert.notEqual(group!.find((item) => item.id === "work")!.disabled, true);
  });

  it("disables Message for the signed-in person, ignoring login case", () => {
    const [group] = buildPersonContextMenuItems({ target: ana, viewerLogin: "ana-lee" });
    assert.equal(group!.find((item) => item.id === "message")!.disabled, true);
    assert.notEqual(group!.find((item) => item.id === "work")!.disabled, true);
  });

  it("keeps Message enabled when no viewer login is known", () => {
    const [group] = buildPersonContextMenuItems({ target: ana, viewerLogin: null });
    assert.equal(group!.find((item) => item.id === "message")!.disabled, false);
  });
});

describe("personMenuPosition", () => {
  it("uses the pointer position for a mouse click", () => {
    const event = { detail: 1, clientX: 120, clientY: 340, currentTarget: null } as unknown as MouseEvent;
    assert.deepEqual(personMenuPosition(event), { x: 120, y: 340 });
  });

  it("anchors a keyboard click to the element corner", () => {
    const element = { getBoundingClientRect: () => ({ left: 30, bottom: 62 }) };
    const event = { detail: 0, clientX: 0, clientY: 0, currentTarget: element } as unknown as MouseEvent;
    assert.deepEqual(personMenuPosition(event), { x: 30, y: 62 });
  });
});
