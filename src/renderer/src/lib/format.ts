const WORDS_PER_MINUTE = 230

export function wordCount(text: string): number {
  return text.match(/\S+/g)?.length ?? 0
}

export function readingMinutes(words: number): number {
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE))
}

export function relativeTime(value: string, now = Date.now()): string {
  const time = new Date(value).getTime()
  if (Number.isNaN(time)) return ''
  const minutes = Math.round((now - time) / 60_000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return new Date(time).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000)
  const minutes = Math.floor(total / 60)
  const seconds = String(total % 60).padStart(2, '0')
  return `${minutes}:${seconds}`
}

export const isMac = window.api.platform === 'darwin'

export const shortcutLabel = (key: string, shift = false): string =>
  isMac ? `${shift ? '⇧' : ''}⌘${key}` : `Ctrl+${shift ? 'Shift+' : ''}${key}`
