export type Page = {
  id: string
  title: string
  body: string
  updatedAt: string
}

export type PageSummary = {
  id: string
  title: string
  updatedAt: string
  preview: string
}

export type WhisperStatus =
  | { state: 'idle' }
  | { state: 'listening' }
  | { state: 'transcribing' }
  | { state: 'downloading'; received: number; total: number }
  | { state: 'error'; message: string }

export type VoicePagesApi = {
  listPages: () => Promise<PageSummary[]>
  getPage: (id: string) => Promise<Page>
  createPage: () => Promise<Page>
  savePage: (page: Pick<Page, 'id' | 'title' | 'body'>) => Promise<Page>
  deletePage: (id: string) => Promise<void>
  copyText: (text: string) => void
  ensureModel: () => Promise<void>
  transcribe: (pcm: Uint8Array) => Promise<string>
  onStatus: (callback: (status: WhisperStatus) => void) => () => void
}
