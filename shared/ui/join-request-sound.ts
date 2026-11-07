/** The same short, two-tap knock in desktop and web. Hosts own mute/deduplication. */
export function createJoinRequestKnock() {
  let context: AudioContext | null = null;
  let voices: Array<{ oscillator: OscillatorNode; gain: GainNode }> = [];

  function stop(): void {
    for (const { oscillator, gain } of voices) {
      try { oscillator.stop(); } catch { /* It may have already ended. */ }
      oscillator.disconnect();
      gain.disconnect();
    }
    voices = [];
  }

  function play(): void {
    try {
      context ??= new AudioContext();
      if (context.state !== 'running') {
        // Browser policy may require a gesture. Never queue an old knock to
        // play after the user later interacts with the page.
        void context.resume().catch(() => undefined);
        return;
      }
      stop();
      const start = context.currentTime + 0.16;
      for (const delay of [0, 0.21]) {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(420, start + delay);
        oscillator.frequency.exponentialRampToValueAtTime(180, start + delay + 0.09);
        gain.gain.setValueAtTime(0.0001, start + delay);
        gain.gain.exponentialRampToValueAtTime(0.24, start + delay + 0.004);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + delay + 0.13);
        oscillator.connect(gain);
        gain.connect(context.destination);
        const voice = { oscillator, gain };
        voices.push(voice);
        oscillator.onended = () => {
          oscillator.disconnect();
          gain.disconnect();
          voices = voices.filter(item => item !== voice);
        };
        oscillator.start(start + delay);
        oscillator.stop(start + delay + 0.15);
      }
    } catch { /* The visible request remains available when audio is unavailable. */ }
  }

  return {
    play,
    stop,
    dispose(): void {
      stop();
      if (context) void context.close().catch(() => undefined);
      context = null;
    },
  };
}
