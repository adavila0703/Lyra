/**
 * Energy-based voice activity detection with an adaptive noise floor.
 *
 * Its only job is gating: speech (plus a short pre-roll so first syllables
 * aren't clipped) is forwarded to the transcriber, silence is not. Sentence
 * boundaries are left to Whisper, which is far better at them than any pause
 * heuristic.
 */

export const SAMPLE_RATE = 16000

const MS = SAMPLE_RATE / 1000
const PRE_ROLL = 300 * MS
const ONSET = 90 * MS
/** A pause this long ends the thought: whatever is pending gets finalized. */
const END_PAUSE = 1200 * MS

const MIN_SPEECH_RMS = 0.004
const MIN_HOLD_RMS = 0.0025
const ONSET_RATIO = 3
const HOLD_RATIO = 1.8
/**
 * Ceilings on the thresholds, so a noisy room (or the floor estimate drifting
 * up) can never make ordinary speech undetectable.
 */
const MAX_SPEECH_RMS = 0.02
const MAX_HOLD_RMS = 0.012
/**
 * The noise floor is the quietest frame in this window ("minimum statistics").
 * Speech always has gaps between syllables within a few seconds, so talking
 * never drags the floor up to the level of the voice.
 */
const FLOOR_WINDOW = Math.round((3 * SAMPLE_RATE) / 512)

export type VoiceEvents = {
  /** Speech started; `frames` is the pre-roll, already including the onset. */
  onStart: (frames: Float32Array[]) => void
  /** A frame of audio during speech (including short pauses). */
  onFrame: (frame: Float32Array) => void
  /** A long pause, or capture stopped. */
  onEnd: () => void
}

export function rms(samples: Float32Array): number {
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return samples.length ? Math.sqrt(sum / samples.length) : 0
}

export type VoiceStats = {
  speaking: boolean
  noiseFloor: number
  onsetThreshold: number
}

export class VoiceDetector {
  private noiseFloor = 0.002
  private recent: number[] = []
  private speaking = false
  private onset = 0
  private silence = 0
  private preRoll: Float32Array[] = []
  private preRollLength = 0

  constructor(private readonly events: VoiceEvents) {}

  /** Feeds one frame of 16 kHz audio and returns its RMS level. */
  push(frame: Float32Array): number {
    const energy = rms(frame)
    this.trackFloor(energy)
    if (this.speaking) this.whileSpeaking(frame, energy)
    else this.whileWaiting(frame, energy)
    return energy
  }

  stats(): VoiceStats {
    return {
      speaking: this.speaking,
      noiseFloor: this.noiseFloor,
      onsetThreshold: this.onsetThreshold()
    }
  }

  private onsetThreshold(): number {
    return Math.min(MAX_SPEECH_RMS, Math.max(MIN_SPEECH_RMS, this.noiseFloor * ONSET_RATIO))
  }

  private holdThreshold(): number {
    return Math.min(MAX_HOLD_RMS, Math.max(MIN_HOLD_RMS, this.noiseFloor * HOLD_RATIO))
  }

  private trackFloor(energy: number): void {
    this.recent.push(energy)
    if (this.recent.length > FLOOR_WINDOW) this.recent.shift()
    const quietest = Math.min(...this.recent)
    // Fall quickly, rise slowly.
    const rate = quietest < this.noiseFloor ? 0.3 : 0.02
    this.noiseFloor += (quietest - this.noiseFloor) * rate
  }

  flush(): void {
    if (this.speaking) {
      this.speaking = false
      this.events.onEnd()
    }
    this.preRoll = []
    this.preRollLength = 0
    this.onset = 0
  }

  private whileWaiting(frame: Float32Array, energy: number): void {
    this.preRoll.push(frame)
    this.preRollLength += frame.length
    while (this.preRollLength - this.preRoll[0].length >= PRE_ROLL) {
      this.preRollLength -= this.preRoll.shift()!.length
    }

    if (energy >= this.onsetThreshold()) {
      this.onset += frame.length
      if (this.onset >= ONSET) {
        this.speaking = true
        this.silence = 0
        this.onset = 0
        this.events.onStart(this.preRoll)
        this.preRoll = []
        this.preRollLength = 0
      }
      return
    }

    this.onset = 0
  }

  private whileSpeaking(frame: Float32Array, energy: number): void {
    this.events.onFrame(frame)
    const voiced = energy >= this.holdThreshold()
    this.silence = voiced ? 0 : this.silence + frame.length
    if (this.silence >= END_PAUSE) {
      this.speaking = false
      this.events.onEnd()
    }
  }
}
