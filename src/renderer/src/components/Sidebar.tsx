import { useMemo, useState } from 'react'
import type { PageSummary, UpdateStatus } from '../../../shared/types'
import lyraIcon from '../assets/lyra-icon.png'
import { relativeTime, shortcutLabel } from '../lib/format'
import { PlusIcon, SearchIcon, TrashIcon } from './Icons'

type Props = {
  pages: PageSummary[]
  activeId: string | undefined
  update: UpdateStatus
  onOpen: (id: string) => void
  onCreate: () => void
  onDelete: (page: PageSummary) => void
}

function updateLabel(status: UpdateStatus): string | null {
  switch (status.state) {
    case 'available':
      return `Update to ${status.version}`
    case 'downloading':
      return status.percent > 0 ? `Downloading… ${status.percent}%` : 'Downloading…'
    case 'ready':
      return 'Restart to update'
    case 'error':
      return 'Update failed — retry'
    default:
      return null
  }
}

export function Sidebar({ pages, activeId, update, onOpen, onCreate, onDelete }: Props) {
  const [query, setQuery] = useState('')

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return pages
    return pages.filter((page) =>
      `${page.title} ${page.preview}`.toLowerCase().includes(needle)
    )
  }, [pages, query])

  const label = updateLabel(update)
  const onUpdate = (): void => {
    if (update.state === 'ready') void window.api.installUpdate()
    else if (update.state !== 'downloading') void window.api.startUpdate()
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-header drag">
        <div className="brand">
          <img src={lyraIcon} alt="" width={22} height={22} />
          <span>Lyra</span>
        </div>
        <button
          className="icon-btn no-drag"
          type="button"
          onClick={onCreate}
          title={`New page (${shortcutLabel('N')})`}
          aria-label="New page"
        >
          <PlusIcon />
        </button>
      </div>

      <label className="search">
        <SearchIcon />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search pages"
        />
      </label>

      <nav className="page-list" aria-label="Pages">
        {visible.length === 0 ? (
          <p className="page-list-empty">{query ? 'No matching pages' : 'No pages yet'}</p>
        ) : (
          visible.map((page) => (
            <div key={page.id} className={`page-row${page.id === activeId ? ' active' : ''}`}>
              <button type="button" className="page-item" onClick={() => onOpen(page.id)}>
                <span className="page-title">{page.title || 'Untitled'}</span>
                <span className="page-meta">
                  <time>{relativeTime(page.updatedAt)}</time>
                  <span className="page-preview">{page.preview}</span>
                </span>
              </button>
              <button
                type="button"
                className="page-delete"
                aria-label={`Delete ${page.title || 'Untitled'}`}
                title="Delete page"
                onClick={() => onDelete(page)}
              >
                <TrashIcon />
              </button>
            </div>
          ))
        )}
      </nav>

      {label ? (
        <div className="sidebar-footer">
          <button
            className="update-chip"
            type="button"
            disabled={update.state === 'downloading'}
            onClick={onUpdate}
          >
            <span className="update-dot" />
            {label}
          </button>
        </div>
      ) : null}
    </aside>
  )
}
