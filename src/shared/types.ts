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
  | { state: 'downloading'; received: number; total: number }
  | { state: 'error'; message: string }

/** A transcribed word. `text` keeps Whisper's leading space; times are in seconds. */
export type TranscriptWord = {
  text: string
  start: number
  end: number
}

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'available'; version: string }
  | { state: 'downloading'; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string }

export type VoicePagesApi = {
  listPages: () => Promise<PageSummary[]>
  getPage: (id: string) => Promise<Page>
  createPage: () => Promise<Page>
  savePage: (page: Pick<Page, 'id' | 'title' | 'body'>) => Promise<Page>
  deletePage: (id: string) => Promise<void>
  copyText: (text: string) => void
  platform: string
  /** Downloads the model if needed and loads it into memory. */
  warmUp: () => Promise<void>
  /** `prompt` is recent text that gives Whisper context for punctuation and vocabulary. */
  transcribe: (pcm: Uint8Array, prompt: string) => Promise<TranscriptWord[]>
  /** Appends a line to the app log (terminal + userData/logs/lyra.log). */
  log: (scope: string, message: string, data?: unknown) => void
  onStatus: (callback: (status: WhisperStatus) => void) => () => void
  startUpdate: () => Promise<void>
  installUpdate: () => Promise<void>
  onUpdateStatus: (callback: (status: UpdateStatus) => void) => () => void
}
