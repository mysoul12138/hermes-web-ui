let audioContext: AudioContext | null = null
let unlocked = false

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext
  if (!AudioContextCtor) return null
  if (!audioContext) audioContext = new AudioContextCtor()
  return audioContext
}

export function unlockCompletionBell() {
  const ctx = getAudioContext()
  if (!ctx || unlocked) return
  const resume = ctx.state === 'suspended' ? ctx.resume() : Promise.resolve()
  resume
    .then(() => {
      const oscillator = ctx.createOscillator()
      const gain = ctx.createGain()
      gain.gain.value = 0.0001
      oscillator.connect(gain)
      gain.connect(ctx.destination)
      oscillator.start()
      oscillator.stop(ctx.currentTime + 0.01)
      unlocked = true
    })
    .catch(() => {
      // Browsers may reject until a direct user gesture; the next send will retry.
    })
}

export function playCompletionBell() {
  const ctx = getAudioContext()
  if (!ctx) return
  const start = ctx.currentTime
  const notes = [
    { frequency: 660, offset: 0, duration: 0.09 },
    { frequency: 880, offset: 0.10, duration: 0.13 },
  ]
  const play = () => {
    for (const note of notes) {
      const oscillator = ctx.createOscillator()
      const gain = ctx.createGain()
      oscillator.type = 'sine'
      oscillator.frequency.setValueAtTime(note.frequency, start + note.offset)
      gain.gain.setValueAtTime(0.0001, start + note.offset)
      gain.gain.exponentialRampToValueAtTime(0.08, start + note.offset + 0.012)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + note.offset + note.duration)
      oscillator.connect(gain)
      gain.connect(ctx.destination)
      oscillator.start(start + note.offset)
      oscillator.stop(start + note.offset + note.duration + 0.03)
    }
  }

  if (ctx.state === 'suspended') {
    ctx.resume().then(play).catch(() => {})
    return
  }
  play()
}
