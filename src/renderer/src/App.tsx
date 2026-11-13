import { useCallback, useEffect, useRef, useState } from 'react'
import type { PageSummary, UpdateStatus, WhisperStatus } from '../../shared/types'
import { DictationDock } from './components/DictationDock'
import { Editor } from './components/Editor'
import { CheckIcon, CopyIcon, PlusIcon } from './components/Icons'
import { Sidebar } from './components/Sidebar'
import { useDictation } from './hooks/useDictation'
import { usePages } from './hooks/usePages'
import { readingMinutes, relativeTime, wordCount } from './lib/format'
import { appendTranscript, promptFor } from './text/transcript'

function toMarkdown(title: string, body: string): string {
  return title && title !== 'Untitled' ? `# ${title}\n\n${body}` : body
}

export default function App(): React.JSX.Element {
  const { pages, current, currentRef, saveState, edit, open, create, remove } = usePages()
  const [status, setStatus] = useState<WhisperStatus>({ state: 'idle' })
  const [update, setUpdate] = useState<UpdateStatus>({ state: 'idle' })
  const [copied, setCopied] = useState(false)
  const titleInput = useRef<HTMLInputElement>(null)
  const scroller = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const stopStatus = window.api.onStatus(setStatus)
    const stopUpdate = window.api.onUpdateStatus(setUpdate)
    return () => {
      stopStatus()
      stopUpdate()
    }
  }, [])

  const onCommit = useCallback(
    (text: string) => {
      const page = currentRef.current
      if (!page) return
      const view = scroller.current
      // Keep new words in view, unless the writer has scrolled up to reread.
      const follow = !view || view.scrollHeight - view.scrollTop - view.clientHeight < 160
      edit({ body: appendTranscript(page.body, text) })
      if (follow) {
        requestAnimationFrame(() => view?.scrollTo({ top: view.scrollHeight, behavior: 'smooth' }))
      }
    },
    [currentRef, edit]
  )

  const getContext = useCallback(() => {
    const page = currentRef.current
    return page ? promptFor(page.title, page.body) : ''
  }, [currentRef])

  const dictation = useDictation({ getContext, onCommit })
  const { recording, stop, start } = dictation

  const toggleDictation = useCallback(() => {
    if (recording) void stop()
    else if (currentRef.current) void start()
  }, [recording, stop, start, currentRef])

  const openPage = async (id: string): Promise<void> => {
    await stop()
    await open(id)
  }

  const newPage = useCallback(async () => {
    await stop()
    await create()
    requestAnimationFrame(() => titleInput.current?.select())
  }, [stop, create])

  const deletePage = async (page: PageSummary): Promise<void> => {
    if (!window.confirm(`Delete “${page.title || 'Untitled'}”? This cannot be undone.`)) return
    if (page.id === current?.id) await stop()
    await remove(page.id)
  }

  const copy = (): void => {
    if (!current?.body) return
    window.api.copyText(toMarkdown(current.title, current.body))
    setCopied(true)
  }

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey)) return
      const key = event.key.toLowerCase()
      if (key === 'd' && event.shiftKey) {
        event.preventDefault()
        toggleDictation()
      } else if (key === 'n' && !event.shiftKey) {
        event.preventDefault()
        void newPage()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleDictation, newPage])

  const words = current ? wordCount(current.body) : 0

  return (
    <div className={`app platform-${window.api.platform}`}>
      <Sidebar
        pages={pages}
        activeId={current?.id}
        update={update}
        onOpen={(id) => void openPage(id)}
        onCreate={() => void newPage()}
        onDelete={(page) => void deletePage(page)}
      />

      <main className="workspace">
        <header className="topbar drag">
          {current ? (
            <>
              <span className="topbar-meta">
                {saveState === 'saving'
                  ? 'Saving…'
                  : `Saved ${relativeTime(current.updatedAt).toLowerCase()}`}
              </span>
              <button
                className="btn no-drag"
                type="button"
                onClick={copy}
                disabled={!current.body}
                title="Copy as Markdown"
              >
                {copied ? <CheckIcon /> : <CopyIcon />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </>
          ) : null}
        </header>

        {status.state === 'downloading' && status.total ? (
          <div className="progress" aria-hidden="true">
            <span style={{ width: `${(status.received / status.total) * 100}%` }} />
          </div>
        ) : null}

        {current ? (
          <>
            <div className="scroller" ref={scroller}>
              <article className="page">
                <input
                  ref={titleInput}
                  className="title-input"
                  value={current.title}
                  onChange={(event) => edit({ title: event.target.value })}
                  placeholder="Untitled"
                  aria-label="Page title"
                />
                <p className="page-stats">
                  {words} {words === 1 ? 'word' : 'words'}
                  {words > 0 ? ` · ${readingMinutes(words)} min read` : ''}
                </p>
                <Editor
                  value={current.body}
                  ghost={dictation.live}
                  listening={dictation.phase === 'listening'}
                  onChange={(body) => edit({ body })}
                />
              </article>
            </div>
            <DictationDock
              phase={dictation.phase}
              micName={dictation.micName}
              status={status}
              error={dictation.error}
              subscribeLevel={dictation.subscribeLevel}
              onToggle={toggleDictation}
            />
          </>
        ) : (
          <div className="empty">
            <h2>Talk your next post into existence</h2>
            <p>
              Create a page and start dictating. Everything is transcribed on this computer and
              saved as Markdown. The first session downloads a ~150 MB speech model.
            </p>
            <button className="btn primary" type="button" onClick={() => void newPage()}>
              <PlusIcon />
              New page
            </button>
          </div>
        )}
      </main>
    </div>
  )
}
