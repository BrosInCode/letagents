import { ref } from 'vue'

export const soundEnabled = ref(localStorage.getItem('lac-sound') !== 'off')
let audioCtx: AudioContext | null = null

export function toggleSound() {
  soundEnabled.value = !soundEnabled.value
  localStorage.setItem('lac-sound', soundEnabled.value ? 'on' : 'off')
}

export function playNotificationSound() {
  if (!soundEnabled.value) return
  try {
    if (!audioCtx)
      audioCtx = new (
        window.AudioContext || (window as any).webkitAudioContext
      )()
    const oscillator = audioCtx.createOscillator()
    const gain = audioCtx.createGain()
    oscillator.connect(gain)
    gain.connect(audioCtx.destination)
    oscillator.frequency.setValueAtTime(880, audioCtx.currentTime)
    oscillator.frequency.setValueAtTime(660, audioCtx.currentTime + 0.08)
    gain.gain.setValueAtTime(0.12, audioCtx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.2)
    oscillator.start(audioCtx.currentTime)
    oscillator.stop(audioCtx.currentTime + 0.2)
  } catch {
    /* audio not available */
  }
}
