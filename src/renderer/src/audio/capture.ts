const TARGET_RATE = 16000
const SILENCE_RMS = 0.004
const SPEECH_RMS = 0.003
const SILENCE_MS = 700
const MIN_SPEECH_SECONDS = 0.55
const MIN_PARTIAL_SECONDS = 0.4
const PARTIAL_EVERY_MS = 650
const MAX_UTTERANCE_SECONDS = 12
const IGNORE_START_MS = 200

function downsample(input: Float32Array, inputRate: number): Float32Array {
  if (Math.abs(inputRate - TARGET_RATE) < 1) {
    return input.slice()
  }

  const ratio = inputRate / TARGET_RATE
  const length = Math.max(1, Math.floor(input.length / ratio))
  const output = new Float32Array(length)

  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * ratio)
    const end = Math.max(start + 1, Math.floor((i + 1) * ratio))
    let sum = 0
    let count = 0
    for (let j = start; j < end && j < input.length; j++) {
      sum += input[j]
      count += 1
    }
    output[i] = count > 0 ? sum / count : 0
  }

  return output
}

function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i]
    sum += value * value
  }
  return Math.sqrt(sum / samples.length)
}

export type CaptureHandle = {
  stop: () => Promise<void>
}

export type CaptureHandlers = {
  onPartial: (pcm: Float32Array) => void | Promise<void>
  onFinal: (pcm: Float32Array) => void | Promise<void>
}

export type CaptureOptions = {
  stream: MediaStream
  onLevel?: (level: number) => void
}

export async function startCapture(
  handlers: CaptureHandlers,
  options: CaptureOptions
): Promise<CaptureHandle> {
  const { stream, onLevel } = options
  const context = new AudioContext()
  await context.resume()

  const source = context.createMediaStreamSource(stream)
  const processor = context.createScriptProcessor(4096, 1, 1)
  const silent = context.createGain()
  silent.gain.value = 0

  let chunks: Float32Array[] = []
  let chunkSamples = 0
  let speechSamples = 0
  let silentMs = 0
  let stopped = false
  let armed = false
  let lastPartialAt = 0
  let flushing: Promise<void> = Promise.resolve()

  const armTimer = window.setTimeout(() => {
    armed = true
  }, IGNORE_START_MS)

  const snapshot = (): Float32Array => {
    const merged = new Float32Array(chunkSamples)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.length
    }
    return merged
  }

  const reset = (): void => {
    chunks = []
    chunkSamples = 0
    speechSamples = 0
    silentMs = 0
    lastPartialAt = 0
  }

  const emitFinal = (force = false): void => {
    const minSamples = Math.floor(TARGET_RATE * MIN_SPEECH_SECONDS)
    if (!force && (chunkSamples < minSamples || speechSamples < minSamples / 3)) {
      reset()
      return
    }
    if (chunkSamples === 0) return
    const merged = snapshot()
    reset()
    if (rms(merged) < SPEECH_RMS) return
    flushing = flushing.then(() => Promise.resolve(handlers.onFinal(merged)))
  }

  const emitPartial = (): void => {
    if (chunkSamples < TARGET_RATE * MIN_PARTIAL_SECONDS) return
    const merged = snapshot()
    if (rms(merged) < SPEECH_RMS) return
    void handlers.onPartial(merged)
  }

  processor.onaudioprocess = (event: AudioProcessingEvent) => {
    if (stopped) return
    const pcm = downsample(event.inputBuffer.getChannelData(0), context.sampleRate)
    const energy = rms(pcm)
    onLevel?.(Math.min(1, energy * 12))
    if (!armed) return

    chunks.push(pcm)
    chunkSamples += pcm.length
    const frameMs = (pcm.length / TARGET_RATE) * 1000
    const now = performance.now()

    if (energy >= SILENCE_RMS) {
      speechSamples += pcm.length
      silentMs = 0
    } else {
      silentMs += frameMs
    }

    if (silentMs >= SILENCE_MS && speechSamples > 0) {
      emitFinal()
      return
    }

    if (chunkSamples >= TARGET_RATE * MAX_UTTERANCE_SECONDS) {
      emitFinal(true)
      return
    }

    if (now - lastPartialAt >= PARTIAL_EVERY_MS && speechSamples > 0) {
      lastPartialAt = now
      emitPartial()
    }
  }

  source.connect(processor)
  processor.connect(silent)
  silent.connect(context.destination)

  return {
    stop: async () => {
      stopped = true
      window.clearTimeout(armTimer)
      emitFinal(true)
      await flushing
      processor.disconnect()
      source.disconnect()
      silent.disconnect()
      await context.close()
      onLevel?.(0)
      for (const mediaTrack of stream.getTracks()) {
        mediaTrack.stop()
      }
    }
  }
}
