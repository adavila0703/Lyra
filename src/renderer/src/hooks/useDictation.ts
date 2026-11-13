import { useCallback, useEffect, useRef, useState } from 'react'
import { openMicrophone, startCapture } from '../audio/capture'
import { StreamingTranscriber } from '../audio/streaming'
import { VoiceDetector } from '../audio/vad'
import { log } from '../lib/log'
import { holdBackCommand } from '../text/transcript'

export type DictationPhase = 'idle' | 'starting' | 'listening' | 'finishing'

type LevelListener = (level: number) => void

/** How often a diagnostic snapshot of the pipeline is logged while recording. */
const HEARTBEAT_MS = 3000

type Options = {
  /** Text that precedes the dictation (title + end of page), read when recording starts. */
  getContext: () => string
  /** Called with each piece of confirmed text, in order. */
  onCommit: (text: string) => void
}

type Session = {
  stop: () => Promise<void>
}

function toBytes(pcm: Float32Array): Uint8Array {
  return new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
}

function transcribe(pcm: Float32Array, prompt: string) {
  return window.api.transcribe(toBytes(pcm), prompt)
}

/**
 * Microphone → voice detector → streaming transcriber.
 *
 * Confirmed words are handed to `onCommit` as soon as Whisper is sure of them;
 * `live` holds the words it is still deciding on, for display as ghost text.
 */
export function useDictation({ getContext, onCommit }: Options) {
  const [phase, setPhase] = useState<DictationPhase>('idle')
  const [live, setLive] = useState('')
  const [micName, setMicName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const session = useRef<Session | null>(null)
  const levelListeners = useRef(new Set<LevelListener>())
  const options = useRef({ getContext, onCommit })
  options.current = { getContext, onCommit }

  const subscribeLevel = useCallback((listener: LevelListener) => {
    levelListeners.current.add(listener)
    return () => {
      levelListeners.current.delete(listener)
    }
  }, [])

  const start = useCallback(async (): Promise<void> => {
    if (session.current) return
    setError(null)
    setLive('')
    setPhase('starting')

    // A trailing "new"/"next" is held until we know whether "paragraph" follows.
    let held = ''
    let tentative = ''
    const showLive = (): void => setLive(held + tentative)
    const fail = (caught: unknown): void => {
      log('dictation', 'error', String(caught))
      setError(caught instanceof Error ? caught.message : 'Transcription failed')
    }
    const commit = (text: string): void => {
      const [ready, rest] = holdBackCommand(held + text)
      held = rest
      if (ready) options.current.onCommit(ready)
      showLive()
    }
    const release = (): void => {
      if (held) options.current.onCommit(held)
      held = ''
      showLive()
    }

    try {
      const [stream] = await Promise.all([openMicrophone(), window.api.warmUp()])
      const streamer = new StreamingTranscriber(
        transcribe,
        {
          onCommit: commit,
          onLive: (text) => {
            tentative = text
            showLive()
          },
          onError: fail
        },
        options.current.getContext()
      )
      const voice = new VoiceDetector({
        onStart: (frames) => {
          log('vad', 'speech started', voice.stats())
          frames.forEach((frame) => streamer.append(frame))
        },
        onFrame: (frame) => streamer.append(frame),
        onEnd: () => {
          log('vad', 'speech ended', voice.stats())
          void streamer.finalize().then(release, fail)
        }
      })

      let frames = 0
      let peak = 0
      let energy = 0
      const capture = await startCapture(
        stream,
        (frame) => {
          const rms = voice.push(frame)
          frames++
          peak = Math.max(peak, rms)
          energy += rms
          const level = Math.min(1, rms * 14)
          levelListeners.current.forEach((listener) => listener(level))
        },
        (reason) => {
          setError(reason)
          void stopRef.current()
        }
      )

      // Expect ~31 frames a second; anything else means the microphone path is stalling.
      const expected = (HEARTBEAT_MS / 1000) * (16000 / 512)
      const heartbeat = setInterval(() => {
        const snapshot = {
          frames,
          peakRms: +peak.toFixed(4),
          meanRms: frames ? +(energy / frames).toFixed(4) : 0,
          ...voice.stats(),
          ...streamer.stats(),
          ...capture.state()
        }
        snapshot.noiseFloor = +snapshot.noiseFloor.toFixed(4)
        snapshot.onsetThreshold = +snapshot.onsetThreshold.toFixed(4)
        const stalled = frames < expected * 0.5 || snapshot.passMs > 8000
        log('dictation', stalled ? 'heartbeat (STALLED)' : 'heartbeat', snapshot)
        frames = peak = energy = 0
      }, HEARTBEAT_MS)

      session.current = {
        stop: async () => {
          clearInterval(heartbeat)
          capture.stop()
          voice.flush()
          levelListeners.current.forEach((listener) => listener(0))
          await streamer.idle()
          release()
        }
      }
      setMicName(capture.micName)
      setPhase('listening')
      log('dictation', 'listening')
    } catch (caught) {
      log('dictation', 'failed to start', String(caught))
      fail(caught)
      setPhase('idle')
    }
  }, [])

  const stop = useCallback(async (): Promise<void> => {
    const current = session.current
    if (!current) return
    session.current = null
    log('dictation', 'stopping')
    setPhase('finishing')
    await current.stop()
    setLive('')
    setMicName('')
    setPhase('idle')
    log('dictation', 'stopped')
  }, [])
  const stopRef = useRef(stop)
  stopRef.current = stop

  useEffect(() => () => void session.current?.stop(), [])

  return {
    phase,
    recording: phase === 'listening' || phase === 'starting',
    live,
    micName,
    error,
    start,
    stop,
    subscribeLevel
  }
}
