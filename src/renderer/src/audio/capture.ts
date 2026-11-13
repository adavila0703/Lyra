import { log } from '../lib/log'
import { SAMPLE_RATE } from './vad'

/** 32 ms frames: small enough for a responsive VAD, large enough to keep messaging cheap. */
const FRAME_SIZE = 512

/**
 * Runs on the audio rendering thread, so UI work on the main thread can never
 * cause dropped samples (unlike the deprecated ScriptProcessorNode).
 */
const WORKLET_SOURCE = `
class FrameCollector extends AudioWorkletProcessor {
  constructor() {
    super()
    this.frame = new Float32Array(${FRAME_SIZE})
    this.filled = 0
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel) return true
    let read = 0
    while (read < channel.length) {
      const count = Math.min(channel.length - read, this.frame.length - this.filled)
      this.frame.set(channel.subarray(read, read + count), this.filled)
      this.filled += count
      read += count
      if (this.filled === this.frame.length) {
        this.port.postMessage(this.frame, [this.frame.buffer])
        this.frame = new Float32Array(${FRAME_SIZE})
        this.filled = 0
      }
    }
    return true
  }
}
registerProcessor('frame-collector', FrameCollector)
`

export type CaptureHandle = {
  micName: string
  /** Audio engine and microphone track state, for diagnostics. */
  state: () => { context: string; track: string; muted: boolean }
  stop: () => void
}

export async function openMicrophone(): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: true
    },
    video: false
  })
  const track = stream.getAudioTracks()[0]
  if (!track || track.readyState !== 'live') {
    stream.getTracks().forEach((t) => t.stop())
    throw new Error(
      'The microphone did not start. Check System Settings → Privacy & Security → Microphone.'
    )
  }
  return stream
}

/** Streams 16 kHz mono frames from `stream` to `onFrame` until stopped. */
export async function startCapture(
  stream: MediaStream,
  onFrame: (frame: Float32Array) => void,
  /** The microphone went away (unplugged, Bluetooth switched profile, revoked). */
  onLost: (reason: string) => void
): Promise<CaptureHandle> {
  // Letting the browser resample to 16 kHz gives proper anti-aliasing for free.
  const context = new AudioContext({ sampleRate: SAMPLE_RATE })
  const moduleUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }))
  try {
    await context.audioWorklet.addModule(moduleUrl)
  } finally {
    URL.revokeObjectURL(moduleUrl)
  }
  await context.resume()

  const source = context.createMediaStreamSource(stream)
  const collector = new AudioWorkletNode(context, 'frame-collector')
  // Chromium only runs nodes that are pulled by the destination, so route through a muted gain.
  const mute = new GainNode(context, { gain: 0 })
  let stopped = false

  collector.port.onmessage = (event: MessageEvent<Float32Array>) => {
    if (!stopped) onFrame(event.data)
  }
  collector.onprocessorerror = () => {
    log('capture', 'audio worklet crashed')
    if (!stopped) onLost('The audio processor stopped unexpectedly.')
  }
  source.connect(collector).connect(mute).connect(context.destination)

  // macOS suspends audio contexts when devices change or the system interrupts audio.
  context.onstatechange = () => {
    log('capture', `audio context ${context.state}`)
    if (!stopped && context.state !== 'running' && context.state !== 'closed') {
      context.resume().then(
        () => log('capture', `audio context resumed (${context.state})`),
        (error) => log('capture', 'audio context resume failed', String(error))
      )
    }
  }

  const track = stream.getAudioTracks()[0]
  const micName = track?.label || 'Microphone'
  if (track) {
    track.onmute = () => log('capture', 'microphone muted by the system', { micName })
    track.onunmute = () => log('capture', 'microphone unmuted', { micName })
    track.onended = () => {
      log('capture', 'microphone track ended', { micName })
      if (!stopped) onLost(`Lost the microphone (${micName}).`)
    }
  }
  log('capture', 'started', {
    micName,
    contextRate: context.sampleRate,
    settings: track?.getSettings()
  })

  return {
    micName,
    state: () => ({
      context: context.state,
      track: track?.readyState ?? 'none',
      muted: track?.muted ?? false
    }),
    stop: () => {
      if (stopped) return
      stopped = true
      log('capture', 'stopped')
      collector.port.onmessage = null
      context.onstatechange = null
      if (track) track.onended = track.onmute = track.onunmute = null
      source.disconnect()
      collector.disconnect()
      mute.disconnect()
      stream.getTracks().forEach((track) => track.stop())
      void context.close()
    }
  }
}
