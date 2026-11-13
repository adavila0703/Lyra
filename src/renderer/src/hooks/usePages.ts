import { useCallback, useEffect, useRef, useState } from 'react'
import type { Page, PageSummary } from '../../../shared/types'

export type SaveState = 'saved' | 'saving'

type Edit = Partial<Pick<Page, 'title' | 'body'>>

const SAVE_DELAY_MS = 400

/** Page list + the open page, with debounced autosave. */
export function usePages() {
  const [pages, setPages] = useState<PageSummary[]>([])
  const [current, setCurrent] = useState<Page | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const currentRef = useRef<Page | null>(null)
  const pendingSave = useRef<{ page: Page; timer: ReturnType<typeof setTimeout> } | null>(null)

  const show = (page: Page | null): void => {
    currentRef.current = page
    setCurrent(page)
  }

  const refreshList = useCallback(async () => {
    const list = await window.api.listPages()
    setPages(list)
    return list
  }, [])

  const write = useCallback(
    async (page: Page) => {
      const saved = await window.api.savePage({ id: page.id, title: page.title, body: page.body })
      if (currentRef.current?.id === saved.id) {
        show({ ...currentRef.current, updatedAt: saved.updatedAt })
      }
      if (!pendingSave.current) setSaveState('saved')
      await refreshList()
    },
    [refreshList]
  )

  /** Writes any pending edit right away (e.g. before switching pages). */
  const flush = useCallback(async () => {
    const pending = pendingSave.current
    if (!pending) return
    clearTimeout(pending.timer)
    pendingSave.current = null
    await write(pending.page)
  }, [write])

  const edit = useCallback(
    (changes: Edit) => {
      const page = currentRef.current
      if (!page) return
      const next = { ...page, ...changes }
      show(next)
      setSaveState('saving')
      if (pendingSave.current) clearTimeout(pendingSave.current.timer)
      const timer = setTimeout(() => {
        pendingSave.current = null
        void write(next)
      }, SAVE_DELAY_MS)
      pendingSave.current = { page: next, timer }
    },
    [write]
  )

  const open = useCallback(
    async (id: string) => {
      await flush()
      show(await window.api.getPage(id))
    },
    [flush]
  )

  const create = useCallback(async () => {
    await flush()
    const page = await window.api.createPage()
    show(page)
    await refreshList()
    return page
  }, [flush, refreshList])

  const remove = useCallback(
    async (id: string) => {
      if (pendingSave.current?.page.id === id) {
        clearTimeout(pendingSave.current.timer)
        pendingSave.current = null
        setSaveState('saved')
      }
      await window.api.deletePage(id)
      const list = await refreshList()
      if (currentRef.current?.id !== id) return
      show(list[0] ? await window.api.getPage(list[0].id) : null)
    },
    [refreshList]
  )

  useEffect(() => {
    void refreshList().then(async (list) => {
      if (list[0] && !currentRef.current) show(await window.api.getPage(list[0].id))
    })
    return () => {
      void flush()
    }
  }, [refreshList, flush])

  return { pages, current, currentRef, saveState, edit, open, create, remove, flush }
}
