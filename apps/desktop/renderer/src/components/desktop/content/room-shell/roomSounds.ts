import { play, type SoundName } from "cuelume";

export type RoomSoundKind = "send" | "notification";

export const roomSoundByKind = {
  send: "release",
  notification: "chime",
} as const satisfies Record<RoomSoundKind, SoundName>;

export function playRoomInteractionSound(
  kind: RoomSoundKind,
  playSound: (sound: SoundName) => void = play,
): void {
  playSound(roomSoundByKind[kind]);
}

/** The short, two-note Needs you signal. No looping audio or delayed autoplay. */
export function createNeedsYouChime() {
  let context: AudioContext | null = null;
  let voices: Array<{ oscillator: OscillatorNode; gain: GainNode }> = [];
  function stop(): void {
    if (!context) return;
    const now = context.currentTime;
    for (const { oscillator, gain } of voices) {
      gain.gain.cancelScheduledValues(now);
      gain.gain.setTargetAtTime(0.0001, now, 0.012);
      oscillator.stop(now + 0.06);
    }
    voices = [];
  }
  return {
    play(): void {
      try {
        context ??= new AudioContext();
        if (context.state !== 'running') {
          // A gesture may unlock the context. Never queue old notes behind it.
          void context.resume().catch(() => undefined);
          return;
        }
        stop();
        const start = context.currentTime + 0.012;
        for (const [frequency, delay, duration] of [[659.25, 0, 0.38], [987.77, 0.115, 0.5]]) {
          const oscillator = context.createOscillator();
          const gain = context.createGain();
          oscillator.type = 'sine';
          oscillator.frequency.value = frequency;
          gain.gain.setValueAtTime(0.0001, start + delay);
          gain.gain.exponentialRampToValueAtTime(0.084, start + delay + 0.009);
          gain.gain.exponentialRampToValueAtTime(0.0001, start + delay + duration);
          oscillator.connect(gain); gain.connect(context.destination);
          const voice = { oscillator, gain };
          voices.push(voice);
          oscillator.onended = () => {
            oscillator.disconnect(); gain.disconnect();
            voices = voices.filter(item => item !== voice);
          };
          oscillator.start(start + delay);
          oscillator.stop(start + delay + duration + 0.03);
        }
      } catch { /* The visible signal works when audio is unavailable. */ }
    },
    stop,
    dispose(): void {
      stop();
      if (context) void context.close().catch(() => undefined);
      context = null;
    },
  };
}
