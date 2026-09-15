import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { startCapture, type CaptureHandle } from './audio/capture'
import lyraIcon from './assets/lyra-icon.png'
import type { Page, PageSummary, WhisperStatus } from '../../shared/types'

function formatUpdated(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

function wordCount(text: string): number {
  const words = text.trim().match(/\S+/g)
  return words ? words.length : 0
}

function statusLabel(
  status: WhisperStatus,
  recording: boolean,
  micLevel: number,
  micName: string
): string {
  if (status.state === 'downloading') {
    if (!status.total) return 'Downloading Whisper model…'
    const pct = Math.round((status.received / status.total) * 100)
    return `Downloading Whisper model… ${pct}%`
  }
  if (status.state === 'error') return status.message
  if (recording) {
    if (micLevel < 0.04) {
      return `${micName || 'Mic'} is silent — talk louder, or enable it in System Settings → Microphone`
    }
    return `Listening on ${micName || 'mic'} · edit anytime`
  }
  if (status.state === 'transcribing') return 'Transcribing…'
  return 'Idle · everything stays on this computer'
}

function appendTranscript(body: string, chunk: string): string {
  const text = chunk.trim()
  if (!text) return body
  if (!body.trim()) return text
  const needsSpace = !/\s$/.test(body)
  const prefix = needsSpace ? `${body} ` : body
  const next = /[.!?]$/.test(body.trim()) ? text.replace(/^./, (ch) => ch.toUpperCase()) : text
  return `${prefix}${next}`
}

function pcmBytes(pcm: Float32Array): Uint8Array {
  return new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength).slice()
}

export default function App(): React.JSX.Element {
  const [pages, setPages] = useState<PageSummary[]>([])
  const [current, setCurrent] = useState<Page | null>(null)
  const [status, setStatus] = useState<WhisperStatus>({ state: 'idle' })
  const [recording, setRecording] = useState(false)
  const [micLevel, setMicLevel] = useState(0)
  const [micName, setMicName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const captureRef = useRef<CaptureHandle | null>(null)
  const currentRef = useRef<Page | null>(null)
  const committedRef = useRef('')
  const liveRef = useRef('')
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const transcribeBusy = useRef(false)
  const queuedAudio = useRef<{ pcm: Float32Array; final: boolean } | null>(null)

  currentRef.current = current

  const refreshList = useCallback(async (preferredId?: string) => {
    const list = await window.api.listPages()
    setPages(list)
    const keepId = preferredId ?? currentRef.current?.id
    if (keepId && list.some((page) => page.id === keepId)) return
    if (!list[0]) {
      committedRef.current = ''
      liveRef.current = ''
      setCurrent(null)
      return
    }
    const page = await window.api.getPage(list[0].id)
    committedRef.current = page.body
    liveRef.current = ''
    setCurrent(page)
    setError(null)
  }, [])

  useEffect(() => {
    void refreshList()
    return window.api.onStatus(setStatus)
  }, [refreshList])

  const persist = useCallback((page: Page, immediate = false) => {
    const write = async (): Promise<void> => {
      const saved = await window.api.savePage({
        id: page.id,
        title: page.title,
        body: page.body
      })
      setCurrent((prev) =>
        prev && prev.id === saved.id ? { ...prev, updatedAt: saved.updatedAt } : prev
      )
      await refreshList(page.id)
    }

    if (saveTimer.current) clearTimeout(saveTimer.current)
    if (immediate) {
      void write()
      return
    }
    saveTimer.current = setTimeout(() => {
      void write()
    }, 300)
  }, [refreshList])

  const showBody = (committed: string, live: string, immediate = false): void => {
    const page = currentRef.current
    if (!page) return
    committedRef.current = committed
    liveRef.current = live
    const body = appendTranscript(committed, live)
    const editor = editorRef.current
    const stickToEnd =
      !!editor &&
      editor.selectionStart === editor.value.length &&
      editor.selectionEnd === editor.value.length
    const next = { ...page, body }
    currentRef.current = next
    setCurrent(next)
    persist(next, immediate)
    if (stickToEnd) {
      requestAnimationFrame(() => {
        const el = editorRef.current
        if (!el) return
        const end = el.value.length
        el.setSelectionRange(end, end)
      })
    }
  }

  const drainAudio = async (): Promise<void> => {
    if (transcribeBusy.current) return
    transcribeBusy.current = true
    try {
      while (queuedAudio.current) {
        const job = queuedAudio.current
        queuedAudio.current = null
        const text = await window.api.transcribe(pcmBytes(job.pcm))
        if (job.final) {
          const committed = text
            ? appendTranscript(committedRef.current, text)
            : committedRef.current
          showBody(committed, '', true)
        } else if (text) {
          showBody(committedRef.current, text)
        }
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Transcription failed'
      setError(message)
      setStatus({ state: 'error', message })
    } finally {
      transcribeBusy.current = false
      if (queuedAudio.current) {
        void drainAudio()
      }
    }
  }

  const queueAudio = (pcm: Float32Array, final: boolean): void => {
    const prev = queuedAudio.current
    if (prev?.final && !final) return
    queuedAudio.current = { pcm, final: Boolean(prev?.final) || final }
    void drainAudio()
  }

  const openPage = async (id: string): Promise<void> => {
    if (recording) await stopRecording()
    const page = await window.api.getPage(id)
    committedRef.current = page.body
    liveRef.current = ''
    setCurrent(page)
    setError(null)
  }

  const onNewPage = async (): Promise<void> => {
    if (recording) await stopRecording()
    const page = await window.api.createPage()
    committedRef.current = page.body
    liveRef.current = ''
    setCurrent(page)
    await refreshList(page.id)
  }

  const onDelete = async (id: string, title: string): Promise<void> => {
    const ok = window.confirm(`Delete “${title || 'Untitled'}”? This cannot be undone.`)
    if (!ok) return
    if (current?.id === id && recording) {
      await captureRef.current?.stop()
      captureRef.current = null
      setRecording(false)
      setMicLevel(0)
      setMicName('')
    }
    await window.api.deletePage(id)
    await refreshList()
  }

  const updateTitle = (title: string): void => {
    setCurrent((prev) => {
      if (!prev) return prev
      const next = { ...prev, title }
      persist(next)
      return next
    })
  }

  const onBodyChange = (value: string): void => {
    committedRef.current = value
    liveRef.current = ''
    if (queuedAudio.current && !queuedAudio.current.final) {
      queuedAudio.current = null
    }
    setCurrent((prev) => {
      if (!prev) return prev
      const next = { ...prev, body: value }
      persist(next)
      return next
    })
  }

  const onCopy = (): void => {
    if (!current?.body) return
    try {
      window.api.copyText(current.body)
      setCopied(true)
      setError(null)
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(false), 1500)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not copy to the clipboard.')
    }
  }

  const stopRecording = async (): Promise<void> => {
    const handle = captureRef.current
    captureRef.current = null
    setRecording(false)
    setMicLevel(0)
    setMicName('')
    await handle?.stop()
    await drainAudio()
    if (liveRef.current) {
      showBody(appendTranscript(committedRef.current, liveRef.current), '', true)
    }
  }

  const startRecording = async (): Promise<void> => {
    if (!current) {
      setError('Create a page before recording.')
      return
    }
    setError(null)
    committedRef.current = current.body
    liveRef.current = ''
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: true
        },
        video: false
      })
      const track = stream.getAudioTracks()[0]
      if (!track || track.readyState !== 'live') {
        throw new Error(
          'The microphone did not start. Check System Settings → Privacy & Security → Microphone.'
        )
      }
      setMicName(track.label || 'Microphone')
      await window.api.ensureModel()
      const handle = await startCapture(
        {
          onPartial: (pcm) => queueAudio(pcm, false),
          onFinal: (pcm) => queueAudio(pcm, true)
        },
        { stream, onLevel: setMicLevel }
      )
      captureRef.current = handle
      setRecording(true)
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Could not start recording'
      setError(message)
      setStatus({ state: 'error', message })
    }
  }

  const toggleRecord = async (): Promise<void> => {
    if (recording) {
      await stopRecording()
      return
    }
    await startRecording()
  }

  useEffect(() => {
    return () => {
      void captureRef.current?.stop()
      if (saveTimer.current) clearTimeout(saveTimer.current)
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
    }
  }, [])

  const downloadPct = useMemo(() => {
    if (status.state !== 'downloading' || !status.total) return 0
    return Math.min(100, Math.round((status.received / status.total) * 100))
  }, [status])

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <img className="brand-icon" src={lyraIcon} alt="" width={28} height={28} />
            <h1>Lyra</h1>
          </div>
          <p>Talk a page out. It saves as you go.</p>
        </div>
        <div className="sidebar-actions">
          <button className="btn primary" type="button" onClick={() => void onNewPage()}>
            New page
          </button>
        </div>
        <div className="page-list">
          {pages.length === 0 ? (
            <p className="meta" style={{ padding: '8px 12px' }}>
              No pages yet.
            </p>
          ) : (
            pages.map((page) => (
              <div
                key={page.id}
                className={`page-row${current?.id === page.id ? ' active' : ''}`}
              >
                <button
                  type="button"
                  className="page-item"
                  onClick={() => void openPage(page.id)}
                >
                  <span className="title">{page.title || 'Untitled'}</span>
                  <span className="meta">
                    {formatUpdated(page.updatedAt)} · {page.preview}
                  </span>
                </button>
                <button
                  type="button"
                  className="page-delete"
                  title={`Delete ${page.title || 'Untitled'}`}
                  aria-label={`Delete ${page.title || 'Untitled'}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    void onDelete(page.id, page.title)
                  }}
                >
                  <svg
                    viewBox="0 0 24 24"
                    width="15"
                    height="15"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M4 7h16" />
                    <path d="M9 7V5h6v2" />
                    <path d="M6 7l1 13h10l1-13" />
                    <path d="M10 11v6M14 11v6" />
                  </svg>
                </button>
              </div>
            ))
          )}
        </div>
      </aside>

      <main className="workspace">
        {status.state === 'downloading' ? (
          <div className="progress" aria-hidden="true">
            <span style={{ width: `${downloadPct}%` }} />
          </div>
        ) : null}

        {current ? (
          <>
            <div className="toolbar">
              <input
                className="title-input"
                value={current.title}
                onChange={(event) => updateTitle(event.target.value)}
                placeholder="Untitled"
              />
              <div className="toolbar-actions">
                {recording ? (
                  <div className="mic-meter" title={micName || 'Microphone'}>
                    <span
                      className="mic-meter-fill"
                      style={{ width: `${Math.round(micLevel * 100)}%` }}
                    />
                  </div>
                ) : null}
                <button
                  className={`btn ${recording ? 'record' : 'primary'}`}
                  type="button"
                  onClick={() => void toggleRecord()}
                >
                  {recording ? 'Stop' : 'Record'}
                </button>
                <button className="btn" type="button" onClick={onCopy} disabled={!current.body}>
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
            <div className="editor-wrap">
              <textarea
                ref={editorRef}
                className="editor"
                value={current.body}
                onChange={(event) => onBodyChange(event.target.value)}
                placeholder="Hit Record and talk. Words show up as you go — you can edit them anytime."
              />
            </div>
            <div className="statusbar">
              <span className={recording ? 'status-listening' : undefined}>
                {error ?? statusLabel(status, recording, micLevel, micName)}
              </span>
              <span>
                {wordCount(current.body)} words · saved {formatUpdated(current.updatedAt) || 'just now'}
              </span>
            </div>
          </>
        ) : (
          <div className="empty">
            <h2>A notebook you can talk into</h2>
            <p>
              Create a page, hit Record, and speak. Transcripts stay on this computer as markdown.
              The first recording downloads Whisper base.en (~150 MB).
            </p>
            <button className="btn primary" type="button" onClick={() => void onNewPage()}>
              New page
            </button>
          </div>
        )}
      </main>
    </div>
  )
}
