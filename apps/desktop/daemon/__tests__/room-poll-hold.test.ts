import assert from "node:assert/strict";
import test from "node:test";

import { RoomPollHold, type RoomPollAttempt } from "../room-poll-hold.js";

const MINUTE = 60_000;

function build() {
  const clock = { now: 1_000_000 };
  const hold = new RoomPollHold(() => clock.now);
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

test("an idle poll climbs from the floor to the target in three steps and stays there", () => {
  const { answered } = build();
  assert.deepEqual([answered(), answered(), answered(), answered(), answered()], [50_000, 100_000, 150_000, 150_000, 150_000]);
});

test("a poll that must not wait asks for the floor and proves nothing new", () => {
  const { hold, answered } = build();
  assert.equal(answered(undefined, true), 25_000);
  assert.equal(hold.start().holdMs, 50_000);
  answered(); answered(); answered();
  assert.equal(hold.start(true).holdMs, 25_000, "also when a longer hold is proven");
  assert.equal(hold.start().holdMs, 150_000);
});

test("an early answer proves only the time it took", () => {
  const { hold, answered } = build();
  assert.equal(answered(3_000), 50_000, "a message arrived after 3 s");
  assert.equal(hold.start().holdMs, 50_000, "3 s is less than the floor, so nothing changed");
  assert.equal(answered(40_500.7), 50_000, "a message arrived after 40.5 s");
  assert.equal(hold.start().holdMs, 81_000, "twice the 40.5 s that the request stayed open, in whole milliseconds");
  assert.equal(answered(81_250), 81_000, "the answer took longer than the hold");
  assert.equal(hold.start().holdMs, 150_000, "the hold is what was proven, not the slow answer: 162 s is past the target");
});

test("a server that holds for less than it is asked never fails a poll and bounds the hold", () => {
  const { answered } = build();
  // The server answers after 60 s at most.
  assert.equal(answered(), 50_000);
  assert.equal(answered(60_000), 100_000);
  assert.equal(answered(60_000), 120_000, "twice the 60 s the server allows");
  assert.equal(answered(60_000), 120_000);
});

test("a probe that is cut falls back to the proven hold and waits out a cool-down", () => {
  const { clock, hold, answered, failed } = build();
  answered();
  // The path ends a request after 60 s.
  const cut = failed(60_000);
  assert.equal(cut.asked, 100_000);
  assert.deepEqual(cut.again, { holdMs: 50_000, provenMs: 50_000 }, "asked again with the hold that is proven");
  assert.equal(answered(), 50_000);
  clock.now += 10 * MINUTE - 50_000 - 1;
  assert.equal(hold.start().holdMs, 50_000, "no probe before the cool-down ends");
  clock.now += 1;
  assert.equal(hold.start().holdMs, 100_000, "then one probes again");
});

test("each cut probe doubles the cool-down, up to one hour", () => {
  const { clock, hold, failed } = build();
  const cooldowns: number[] = [];
  for (let round = 0; round < 5; round += 1) {
    assert.equal(failed(30_000).asked, 50_000);
    const from = clock.now;
    while (hold.start().holdMs === 25_000) clock.now += MINUTE;
    cooldowns.push((clock.now - from) / MINUTE);
  }
  assert.deepEqual(cooldowns, [10, 20, 40, 60, 60]);
});

test("a probe that succeeds above the old limit ends the doubling", () => {
  const { clock, hold, answered, failed } = build();
  answered();
  failed(60_000);
  clock.now += 10 * MINUTE;
  failed(60_000);
  clock.now += 20 * MINUTE;
  // The limit of 60 s is gone: another network, or a changed proxy.
  assert.equal(answered(), 100_000);
  assert.equal(hold.start().holdMs, 150_000);
  // The next limit starts with the short cool-down again, not with 40 minutes.
  assert.equal(failed(120_000).again?.holdMs, 100_000, "the probe to 150 s was cut after 120 s");
  clock.now += 10 * MINUTE - 1;
  assert.equal(hold.start().holdMs, 100_000);
  clock.now += 1;
  assert.equal(hold.start().holdMs, 150_000);
});

test("a failure that a floor poll would have met too is not the hold's", () => {
  const { hold, answered, failed } = build();
  assert.equal(failed(24_999).again, null, "the request was open for less than the floor");
  assert.equal(failed(45_000, hold.start(true)).again, null, "the poll asked for the floor");
  assert.equal(hold.start().holdMs, 50_000, "and nothing was learned");
  answered(); answered(); answered();
  assert.equal(failed(2_000).again, null);
  assert.equal(hold.start().holdMs, 150_000);
});

test("a poll that dies earlier than one once lived proves the path again from the floor, with no cool-down", () => {
  const { hold, answered, failed } = build();
  answered(); answered(); answered();
  // The laptop moved behind a proxy that ends a request after 60 s.
  const moved = failed(60_000);
  assert.equal(moved.asked, 150_000);
  assert.deepEqual(moved.again, { holdMs: 25_000, provenMs: 25_000 });
  assert.equal(answered(), 50_000, "the proof starts again at once");
  assert.equal(failed(60_000).again?.holdMs, 50_000, "and now the probe meets the new limit");
  assert.equal(hold.start().holdMs, 50_000);
});

test("a proven hold that gets no answer at all proves the path again from the floor", () => {
  const { hold, answered, failed } = build();
  answered(); answered(); answered();
  // The poll's own deadline, 20 s after the hold.
  assert.deepEqual(failed(170_000).again, { holdMs: 25_000, provenMs: 25_000 });
  assert.equal(hold.start().holdMs, 50_000);
});

test("a probe that gets no answer at all keeps the proven hold and waits out a cool-down", () => {
  const { clock, hold, answered, failed } = build();
  answered();
  assert.equal(failed(120_000).again?.holdMs, 50_000);
  assert.equal(hold.start().holdMs, 50_000);
  clock.now += 10 * MINUTE;
  assert.equal(hold.start().holdMs, 100_000);
});

test("probes of several agents that one limit cuts together are one round", () => {
  const { clock, hold, answered } = build();
  answered();
  const probes = [hold.start(), hold.start(), hold.start()];
  clock.now += 60_000;
  for (const probe of probes) assert.equal(hold.failed(probe, 60_000)?.holdMs, 50_000);
  clock.now += 10 * MINUTE;
  assert.equal(hold.start().holdMs, 100_000, "one cool-down of 10 minutes, not three doublings");
});

test("polls of several agents that end together after the path changed start no cool-down", () => {
  const { clock, hold, answered } = build();
  answered(); answered(); answered();
  // A restarted server ends every open poll.
  const open = [hold.start(), hold.start(), hold.start()];
  clock.now += 80_000;
  for (const poll of open) assert.deepEqual(hold.failed(poll, 80_000), { holdMs: 25_000, provenMs: 25_000 });
  assert.deepEqual([answered(), answered(), answered()], [50_000, 100_000, 150_000], "the hold is back after three polls");
});

test("a probe that is cut after another poll reset the proof starts no cool-down", () => {
  const { clock, hold, answered } = build();
  answered();
  const [first, second] = [hold.start(), hold.start()];
  assert.equal(second.holdMs, 100_000);
  // The path changed under both probes: one dies after 30 s, the other after 60 s.
  clock.now += 30_000;
  assert.equal(hold.failed(first, 30_000)?.holdMs, 25_000);
  clock.now += 30_000;
  assert.equal(hold.failed(second, 60_000)?.holdMs, 25_000);
  assert.equal(hold.start().holdMs, 50_000, "the next poll probes again at once");
});
