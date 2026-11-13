import { useEffect, useRef, useState } from 'react'
import type { WhisperStatus } from '../../../shared/types'
import type { DictationPhase } from '../hooks/useDictation'
import { formatDuration, shortcutLabel } from '../lib/format'
import { MicIcon, StopIcon } from './Icons'

const BAR_COUNT = 28

type SubscribeLevel = (listener: (level: number) => void) => () => void

type Props = {
  phase: DictationPhase
  micName: string
  status: WhisperStatus
  error: string | null
  subscribeLevel: SubscribeLevel
  onToggle: () => void
}

/**
 * Scrolling level history. Writes straight to the DOM so ~30 updates a second
 * never re-render React (or the editor).
 */
function Waveform({ subscribe }: { subscribe: SubscribeLevel }) {
  const bars = useRef<Array<HTMLSpanElement | null>>([])

  useEffect(() => {
    const history = new Array<number>(BAR_COUNT).fill(0)
    return subscribe((level) => {
      history.shift()
      history.push(level)
      history.forEach((value, i) => {
        const bar = bars.current[i]
        if (bar) bar.style.transform = `scaleY(${0.12 + Math.min(1, value * 1.6) * 0.88})`
      })
    })
  }, [subscribe])

  return (
    <div className="waveform" aria-hidden="true">
      {Array.from({ length: BAR_COUNT }, (_, i) => (
        <span key={i} ref={(el) => void (bars.current[i] = el)} />
      ))}
    </div>
  )
}

function useElapsed(running: boolean): number {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (!running) return
    const startedAt = Date.now()
    setElapsed(0)
    const timer = setInterval(() => setElapsed(Date.now() - startedAt), 250)
    return () => clearInterval(timer)
  }, [running])
  return elapsed
}

function statusText(phase: DictationPhase, status: WhisperStatus, micName: string): string {
  if (status.state === 'downloading') {
    const pct = status.total ? Math.round((status.received / status.total) * 100) : 0
    return `Downloading speech model… ${pct}%`
  }
  if (phase === 'starting') return 'Warming up…'
  if (phase === 'finishing') return 'Finishing up…'
  if (phase === 'listening') return micName ? `Listening · ${micName}` : 'Listening'
  return 'Start dictating'
}

export function DictationDock(props: Props) {
  const { phase, micName, status, error, subscribeLevel, onToggle } = props
  const listening = phase === 'listening'
  const busy = phase === 'starting' || phase === 'finishing'
  const elapsed = useElapsed(listening)
  const button = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    return subscribeLevel((level) => {
      button.current?.style.setProperty('--level', String(Math.min(1, level * 1.6)))
    })
  }, [subscribeLevel])

  return (
    <div className="dock-area">
      {error ? (
        <p className="dock-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className={`dock${listening ? ' is-listening' : ''}`}>
        <button
          ref={button}
          type="button"
          className="mic-btn"
          onClick={onToggle}
          disabled={busy}
          aria-label={listening ? 'Stop dictation' : 'Start dictation'}
          title={`${listening ? 'Stop' : 'Start'} dictation (${shortcutLabel('D', true)})`}
        >
          {listening ? <StopIcon /> : <MicIcon />}
        </button>

        <div className="dock-body">
          <span className="dock-status">{statusText(phase, status, micName)}</span>
          {listening ? (
            <span className="dock-hint">Say “new paragraph” to break</span>
          ) : (
            <span className="dock-hint">
              <kbd>{shortcutLabel('D', true)}</kbd>
            </span>
          )}
        </div>

        {listening ? (
          <>
            <Waveform subscribe={subscribeLevel} />
            <span className="dock-timer">{formatDuration(elapsed)}</span>
          </>
        ) : null}
      </div>
    </div>
  )
}
