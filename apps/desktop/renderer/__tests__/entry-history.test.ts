import assert from "node:assert/strict";
import test from "node:test";
import { effectScope, ref } from "vue";

import type { SidebarEntry } from "../src/components/desktop/types";
import { useEntryHistory } from "../src/composables/useEntryHistory";

const place = (id: string) => ({ id, type: "room", title: id } as unknown as SidebarEntry);

function harness(gone: string[] = [], recording?: () => boolean) {
  const activeEntry = ref<SidebarEntry>(place("welcome"));
  const scope = effectScope();
  const history = scope.run(() => useEntryHistory({
    activeEntry,
    open: (entry) => { activeEntry.value = entry; },
    resolve: (entry) => (gone.includes(entry.id) ? null : entry),
    recording,
  }))!;
  return { activeEntry, history, stop: () => scope.stop() };
}

test("back and forward move through opened places like a browser", () => {
  const { activeEntry, history, stop } = harness();
  assert.equal(history.canGoBack.value, false);
  activeEntry.value = place("misty-hill");
  activeEntry.value = place("my-work");
  history.goBack();
  assert.equal(activeEntry.value.id, "misty-hill");
  history.goBack();
  assert.equal(activeEntry.value.id, "welcome");
  assert.equal(history.canGoBack.value, false);
  history.goForward();
  assert.equal(activeEntry.value.id, "misty-hill");
  assert.equal(history.canGoForward.value, true);
  stop();
});

test("opening a new place after going back clears the forward list", () => {
  const { activeEntry, history, stop } = harness();
  activeEntry.value = place("misty-hill");
  history.goBack();
  assert.equal(history.canGoForward.value, true);
  activeEntry.value = place("pearl-leaf");
  assert.equal(history.canGoForward.value, false);
  history.goBack();
  assert.equal(activeEntry.value.id, "welcome");
  stop();
});

test("a place that is gone is skipped", () => {
  const { activeEntry, history, stop } = harness(["deleted-room"]);
  activeEntry.value = place("deleted-room");
  activeEntry.value = place("pearl-leaf");
  history.goBack();
  assert.equal(activeEntry.value.id, "welcome", "the deleted room is passed over");
  stop();
});

test("the start-up switch from a placeholder to the restored room is no step back", () => {
  let started = false;
  const { activeEntry, history, stop } = harness([], () => started);
  activeEntry.value = place("restored-room");
  assert.equal(history.canGoBack.value, false);
  started = true;
  activeEntry.value = place("pearl-leaf");
  history.goBack();
  assert.equal(activeEntry.value.id, "restored-room");
  stop();
});
