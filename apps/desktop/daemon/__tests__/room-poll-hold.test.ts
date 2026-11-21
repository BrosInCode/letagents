import assert from "node:assert/strict";
import test from "node:test";

import { RoomPollHold, type RoomPollAttempt, type RoomPollHoldLimits } from "../room-poll-hold.js";

const MINUTE = 60_000;

function build(limits?: RoomPollHoldLimits) {
  const clock = { now: 1_000_000 };
  const hold = new RoomPollHold(() => clock.now, limits);
  /** One poll that stays open `openMs` and is then answered; returns the hold it asked for. */
  const answered = (openMs?: number, atFloor = false): number => {
    const attempt = hold.start(atFloor);
    const open = openMs ?? attempt.holdMs;
    clock.now += open;
    hold.answered(attempt, open);
    return attempt.holdMs;
  };
  /** One poll that fails after `openMs`; returns the hold it asked for and the poll to make again. */
  const failed = (openMs: number, attempt = hold.start()): { asked: number; again: RoomPollAttempt | null } => {
    clock.now += openMs;
    return { asked: attempt.holdMs, again: hold.failed(attempt, openMs) };
  };
  return { clock, hold, answered, failed };
}

test("an idle poll goes from the floor to the target in one step and stays there", () => {
  const { hold, answered } = build();
  assert.deepEqual(hold.start(), { holdMs: 50_000, provenMs: 25_000 }, "the first long hold is a probe");
  assert.deepEqual([answered(), answered(), answered()], [50_000, 50_000, 50_000]);
  assert.deepEqual(hold.start(), { holdMs: 50_000, provenMs: 50_000 }, "then it is proven");
});

test("a higher target only makes the climb longer", () => {
  const { answered } = build({ targetMs: 150_000 });
  assert.deepEqual([answered(), answered(), answered(), answered()], [50_000, 100_000, 150_000, 150_000]);
});

test("a poll that must not wait asks for the floor and proves nothing new", () => {
  const { hold, answered } = build();
  assert.equal(answered(undefined, true), 25_000);
  assert.deepEqual(hold.start(), { holdMs: 50_000, provenMs: 25_000 });
  answered();
  assert.deepEqual(hold.start(true), { holdMs: 25_000, provenMs: 50_000 }, "also when a longer hold is proven");
  assert.deepEqual(hold.start(), { holdMs: 50_000, provenMs: 50_000 });
});

test("an early answer proves only the time it took", () => {
  // With a far target, the next hold shows what an answer proved: it is twice that time.
  const { hold, answered } = build({ targetMs: 150_000 });
  assert.equal(answered(3_000), 50_000, "a message arrived after 3 s");
  assert.equal(hold.start().holdMs, 50_000, "3 s is less than the floor, so nothing changed");
  assert.equal(answered(27_300.7), 50_000, "a message arrived after 27.3 s");
  assert.equal(hold.start().holdMs, 54_600, "twice the 27.3 s that the request stayed open, in whole milliseconds");
  assert.equal(answered(54_900), 54_600, "the answer took longer than the hold");
  assert.equal(hold.start().holdMs, 109_200, "the hold is what was proven, not the slow answer");
});

test("a server that holds for less than it is asked never fails a poll and bounds the hold", () => {
  const { answered } = build({ targetMs: 150_000 });
  // The server answers after 30 s at most.
  assert.deepEqual([answered(30_000), answered(30_000), answered(30_000)], [50_000, 60_000, 60_000]);
});

test("a probe that is cut falls back to the proven hold and waits out a cool-down", () => {
  const { clock, hold, answered, failed } = build();
  assert.equal(answered(30_000), 50_000, "a message arrived after 30 s, so 30 s is proven");
  // The path ends a request after 40 s.
  const cut = failed(40_000);
  assert.equal(cut.asked, 50_000);
  assert.deepEqual(cut.again, { holdMs: 30_000, provenMs: 30_000 }, "asked again with the hold that is proven");
  assert.equal(answered(), 30_000);
  clock.now += 10 * MINUTE - 30_000 - 1;
  assert.equal(hold.start().holdMs, 30_000, "no probe before the cool-down ends");
  clock.now += 1;
  assert.equal(hold.start().holdMs, 50_000, "then the next poll probes again");
});

test("each cut probe doubles the cool-down, up to one hour", () => {
  const { clock, hold, failed } = build();
  const cooldowns: number[] = [];
  for (let round = 0; round < 5; round += 1) {
    // The path ends a request after 30 s, so nothing above the floor is ever proven.
    assert.deepEqual(failed(30_000), { asked: 50_000, again: { holdMs: 25_000, provenMs: 25_000 } });
    const from = clock.now;
    while (hold.start().holdMs === 25_000) clock.now += MINUTE;
    cooldowns.push((clock.now - from) / MINUTE);
  }
  assert.deepEqual(cooldowns, [10, 20, 40, 60, 60]);
});

test("a probe that succeeds above the old limit ends the doubling", () => {
  const { clock, hold, answered, failed } = build();
  failed(30_000);
  clock.now += 10 * MINUTE;
  failed(30_000);
  clock.now += 20 * MINUTE;
  // The limit of 30 s is gone: another network, or a changed proxy.
  assert.equal(answered(), 50_000);
  // Later a limit of 40 s appears. It starts with the short cool-down again, not with 40 minutes.
  assert.equal(failed(40_000).again?.holdMs, 25_000, "the proven hold was cut, so the proof starts again");
  assert.equal(failed(40_000).again?.holdMs, 25_000, "and the probe to 50 s was cut");
  clock.now += 10 * MINUTE - 1;
  assert.equal(hold.start().holdMs, 25_000);
  clock.now += 1;
  assert.equal(hold.start().holdMs, 50_000);
});

test("a failure that a floor poll would have met too is not the hold's", () => {
  const { hold, answered, failed } = build();
  assert.equal(failed(24_999).again, null, "the request was open for less than the floor");
  assert.equal(failed(45_000, hold.start(true)).again, null, "the poll asked for the floor");
  assert.deepEqual(hold.start(), { holdMs: 50_000, provenMs: 25_000 }, "and nothing was learned: no cool-down");
  answered();
  assert.equal(failed(2_000).again, null);
  assert.deepEqual(hold.start(), { holdMs: 50_000, provenMs: 50_000 }, "the proof is kept");
});

test("a poll that dies earlier than one once lived proves the path again from the floor, with no cool-down", () => {
  const { hold, answered, failed } = build();
  answered();
  // The laptop moved behind a proxy that ends a request after 40 s.
  const moved = failed(40_000);
  assert.equal(moved.asked, 50_000);
  assert.deepEqual(moved.again, { holdMs: 25_000, provenMs: 25_000 });
  const probe = failed(40_000);
  assert.equal(probe.asked, 50_000, "the proof starts again at once");
  assert.equal(probe.again?.holdMs, 25_000, "and now the probe meets the new limit");
  assert.equal(hold.start().holdMs, 25_000);
});

test("a proven hold that gets no answer at all proves the path again from the floor", () => {
  const { hold, answered, failed } = build();
  answered();
  // The poll's own deadline, 20 s after the hold.
  assert.deepEqual(failed(70_000).again, { holdMs: 25_000, provenMs: 25_000 });
  assert.deepEqual(hold.start(), { holdMs: 50_000, provenMs: 25_000 }, "the next poll probes at once");
});

test("a probe that gets no answer at all keeps the proven hold and waits out a cool-down", () => {
  const { clock, hold, failed } = build();
  // The poll's own deadline, 20 s after the hold.
  assert.equal(failed(70_000).again?.holdMs, 25_000);
  assert.equal(hold.start().holdMs, 25_000);
  clock.now += 10 * MINUTE;
  assert.equal(hold.start().holdMs, 50_000);
});

test("probes of several agents that one limit cuts together are one round", () => {
  const { clock, hold } = build();
  const probes = [hold.start(), hold.start(), hold.start()];
  clock.now += 30_000;
  for (const probe of probes) assert.equal(hold.failed(probe, 30_000)?.holdMs, 25_000);
  clock.now += 10 * MINUTE;
  assert.deepEqual([hold.start().holdMs, hold.start().holdMs], [50_000, 50_000],
    "one cool-down of 10 minutes, not three doublings; then every agent's next poll probes");
});

test("polls of several agents that end together after the path changed start no cool-down", () => {
  const { clock, hold, answered } = build();
  answered();
  // A restarted server ends every open poll.
  const open = [hold.start(), hold.start(), hold.start()];
  clock.now += 40_000;
  for (const poll of open) assert.deepEqual(hold.failed(poll, 40_000), { holdMs: 25_000, provenMs: 25_000 });
  assert.deepEqual([answered(), answered()], [50_000, 50_000], "the hold is back with the next poll");
});

test("a probe that is cut after another poll reset the proof starts no cool-down", () => {
  const { clock, hold, answered } = build();
  answered(30_000);
  const [first, second] = [hold.start(), hold.start()];
  assert.deepEqual(second, { holdMs: 50_000, provenMs: 30_000 });
  // The path changed under both probes: one dies after 27 s, the other after 35 s.
  clock.now += 27_000;
  assert.equal(hold.failed(first, 27_000)?.holdMs, 25_000);
  clock.now += 8_000;
  assert.equal(hold.failed(second, 35_000)?.holdMs, 25_000);
  assert.equal(hold.start().holdMs, 50_000, "the next poll probes again at once");
});
