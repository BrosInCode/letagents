import assert from "node:assert/strict";
import test from "node:test";

import {
  playRoomInteractionSound,
  roomSoundByKind,
  createNeedsYouChime,
} from "../src/components/desktop/content/room-shell/roomSounds";

test("desktop room send and notification feedback use distinct Cuelume sounds", () => {
  const played: string[] = [];

  playRoomInteractionSound("send", (sound) => played.push(sound));
  playRoomInteractionSound("notification", (sound) => played.push(sound));

  assert.deepEqual(roomSoundByKind, {
    send: "release",
    notification: "chime",
  });
  assert.deepEqual(played, ["release", "chime"]);
});

test("Needs you plays the approved two-note chime and releases interrupted audio", () => {
  const original = globalThis.AudioContext;
  const oscillators: Array<{ frequency: { value: number }; type: string; startAt?: number; stoppedAt?: number; disconnected?: boolean; onended?: () => void; connect(): void; disconnect(): void; start(at: number): void; stop(at: number): void }> = [];
  let contextState = 'running'; let resumed = 0; let closed = 0;
  const peaks: number[] = [];
  class AudioEngine {
    state = contextState;
    currentTime = 1;
    destination = {};
    createOscillator() {
      const oscillator = { frequency: { value: 0 }, type: '', connect() {}, disconnect() { this.disconnected = true; },
        start(at: number) { this.startAt = at; }, stop(at: number) { this.stoppedAt = at; } } as typeof oscillators[number];
      oscillators.push(oscillator); return oscillator;
    }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime(value: number) { peaks.push(value); }, cancelScheduledValues() {}, setTargetAtTime() {} }, connect() {}, disconnect() {} }; }
    async resume() { resumed++; }
    async close() { closed++; }
  }
  Object.assign(globalThis, { AudioContext: AudioEngine });
  try {
    const chime = createNeedsYouChime();
    chime.play();
    assert.deepEqual(oscillators.map(voice => voice.frequency.value), [659.25, 987.77]);
    assert.deepEqual(oscillators.map(voice => voice.type), ['sine', 'sine']);
    assert.equal(oscillators[0].startAt, 1.012);
    assert.equal(oscillators[1].startAt, 1.127);
    assert.deepEqual(peaks, [0.084, 0.0001, 0.084, 0.0001]);
    chime.play();
    assert.deepEqual(oscillators.slice(0, 2).map(voice => voice.stoppedAt), [1.06, 1.06], 'rapid arrivals replace the prior chime');
    oscillators[0].onended?.(); assert.equal(oscillators[0].disconnected, true);
    chime.dispose(); assert.equal(closed, 1);
    assert.equal(oscillators.at(-1)?.stoppedAt, 1.06);
    contextState = 'suspended';
    const blocked = createNeedsYouChime(); blocked.play();
    assert.equal(resumed, 1); assert.equal(oscillators.length, 4, 'autoplay cannot queue stale notes for a later gesture');
    blocked.dispose();
    Object.assign(globalThis, { AudioContext: undefined });
    assert.doesNotThrow(() => { const unavailable = createNeedsYouChime(); unavailable.play(); unavailable.dispose(); });
  } finally { Object.assign(globalThis, { AudioContext: original }); }
});
