import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  maxThreadPaneWidthForContainer,
  shouldOverlayThreadPane,
} from "../src/components/desktop/content/room-chat/thread-layout";

describe("desktop thread layout", () => {
  it("uses an overlay when the chat container cannot fit both panes", () => {
    assert.equal(shouldOverlayThreadPane(788), true);
    assert.equal(shouldOverlayThreadPane(889), true);
    assert.equal(shouldOverlayThreadPane(890), false);
  });

  it("sizes the thread pane from its chat container rather than the window", () => {
    assert.equal(maxThreadPaneWidthForContainer(950), 380);
    assert.equal(maxThreadPaneWidthForContainer(1_200), 560);
  });
});
