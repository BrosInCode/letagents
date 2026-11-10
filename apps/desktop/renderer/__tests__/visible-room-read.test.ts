import assert from "node:assert/strict";
import { test } from "node:test";
import { createRestoreGuard, createThrottledCheck, lastVisibleRoomMessageId, provenRoomRead, roomListReadState } from "../src/domain/visible-room-read";

/** A message list 0..500 px tall with rows at the given top/height, as the browser would measure them. */
function page(rows: Array<{ id: string; top: number; height: number; hidden?: boolean }>, state: { visible?: boolean; focused?: boolean } = {}) {
  const elements = rows.map((row) => ({
    dataset: { messageId: row.id },
    classList: { contains: (name: string) => Boolean(row.hidden) && name === "room-window-pinned-hidden" },
    getBoundingClientRect: () => ({ top: row.top, bottom: row.top + row.height, height: row.height }),
  }));
  const list = { getBoundingClientRect: () => ({ top: 0, bottom: 500, height: 500 }), querySelectorAll: () => elements };
  return {
    visibilityState: state.visible === false ? "hidden" : "visible",
    hasFocus: () => state.focused !== false,
    querySelector: (selector: string) => selector === '[data-testid="room-chat-list"]' ? list : null,
  } as never;
}

test("the newest message counts as seen when half of it, or 96 px of it, is on screen", () => {
  assert.equal(lastVisibleRoomMessageId(page([
    { id: "msg_1", top: 0, height: 100 },
    { id: "msg_2", top: 400, height: 100 },
    { id: "msg_3", top: 460, height: 100 }, // 40 of 100 px shown: not seen
  ])), "msg_2");
  assert.equal(lastVisibleRoomMessageId(page([{ id: "msg_7", top: 380, height: 400 }])), "msg_7", "a tall message with 120 px on screen");
  assert.equal(lastVisibleRoomMessageId(page([{ id: "msg_8", top: 0, height: 50 }, { id: "msg_9", top: 100, height: 50, hidden: true }])), "msg_8");
});

test("a person scrolled up has seen only what shows", () => {
  // The person scrolled up: msg_40 is the newest on screen although msg_90 exists below.
  assert.equal(lastVisibleRoomMessageId(page([
    { id: "msg_39", top: 100, height: 100 }, { id: "msg_40", top: 300, height: 100 }, { id: "msg_90", top: 2000, height: 100 },
  ])), "msg_40");
});

test("a hidden or unfocused window, or no room list, proves no read", () => {
  const rows = [{ id: "msg_1", top: 0, height: 100 }];
  assert.equal(lastVisibleRoomMessageId(page(rows, { visible: false })), null);
  assert.equal(lastVisibleRoomMessageId(page(rows, { focused: false })), null);
  assert.equal(lastVisibleRoomMessageId({ visibilityState: "visible", hasFocus: () => true, querySelector: () => null } as never), null);
  assert.equal(lastVisibleRoomMessageId(null), null);
});

const main = (id: number) => ({ id: `msg_${id}`, threadRootId: `msg_${id}`, source: "agent", sender: "Agent", agentPromptKind: null, text: "hi" }) as never as import("../../electron/ipc-types").DesktopRoomMessage;
const reply = (id: number, root: number) => ({ ...main(id), threadRootId: `msg_${root}` });
const github = (id: number) => ({ ...main(id), source: "github", sender: "github" });

test("at the bottom, a read reaches the room's newest message even when it is a thread reply or a hidden GitHub event", () => {
  const atBottom = { seen: "msg_5", rendered: "msg_5" };
  assert.equal(provenRoomRead(atBottom, [main(4), main(5), reply(6, 4)]), "msg_6", "a trailing thread reply");
  assert.equal(provenRoomRead(atBottom, [main(5), github(6), reply(7, 5)]), "msg_7", "a trailing hidden GitHub event");
  const status = (id: number) => ({ ...main(id), text: "[status] reading the diff" });
  assert.equal(provenRoomRead(atBottom, [main(5), status(6)]), "msg_6", "a trailing agent [status] post, which the room view hides");
  assert.equal(provenRoomRead(atBottom, [main(5), { ...main(6), source: "browser", text: "[status] is how a person began" }]), "msg_5",
    "a person's line is shown, whatever it starts with");
  assert.equal(provenRoomRead({ seen: "msg_4", rendered: "msg_5" }, [main(4), main(5), reply(6, 4)]), "msg_4", "scrolled up: only what shows");
  assert.equal(provenRoomRead(atBottom, [main(5), main(6)]), "msg_5", "a newer main message the list has not drawn yet");
  assert.equal(provenRoomRead({ seen: null, rendered: "msg_5" }, [main(5)]), null);
  assert.deepEqual(roomListReadState(page([{ id: "msg_1", top: 0, height: 100 }, { id: "msg_2", top: 900, height: 100 }])), { seen: "msg_1", rendered: "msg_2" });
});

test("the on-screen check runs at a fixed rate during a burst, and once after it", () => {
  let now = 0;
  const timers: Array<{ at: number; run: () => void }> = [];
  const runs: number[] = [];
  const check = createThrottledCheck(() => runs.push(now), 250, {
    now: () => now, set: (run, ms) => { const timer = { at: now + ms, run }; timers.push(timer); return timer; },
    clear: (timer) => { timers.splice(timers.indexOf(timer as never), 1); },
  });
  const advance = (ms: number) => {
    const until = now + ms;
    for (let next = timers.sort((a, b) => a.at - b.at)[0]; next && next.at <= until; next = timers.sort((a, b) => a.at - b.at)[0]) {
      timers.shift(); now = next.at; next.run();
    }
    now = until;
  };
  // A message every 100 ms for 2 s.
  for (let t = 0; t < 2_000; t += 100) { check.schedule(); advance(100); }
  advance(1_000);
  assert.ok(runs.length >= 8, `checked ${runs.length} times during the burst`);
  assert.ok(runs.every((at, index) => index === 0 || at - runs[index - 1]! >= 250), "never more often than every 250 ms");
  check.dispose();
});

test("a room opened at a saved position proves no read until the list reports its restored position", () => {
  const positions: Record<string, unknown> = { "room-a": { top: 100 } };
  const guard = createRestoreGuard((room) => positions[room] ?? null);
  guard.note("room-a");
  assert.equal(guard.blocks("room-a"), true, "the screen still shows the bottom before the restore");
  positions["room-a"] = { top: 120 };
  assert.equal(guard.blocks("room-a"), false, "restored");
  guard.note("room-b");
  assert.equal(guard.blocks("room-b"), false, "a room with no saved position opens where it is read");
});
