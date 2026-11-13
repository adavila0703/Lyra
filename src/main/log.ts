import { app } from 'electron'
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A tiny line logger for diagnosing dictation. Lines go to the terminal and to
 * `<userData>/logs/lyra.log`, which is rotated once it passes a few megabytes.
 */

const MAX_BYTES = 5 * 1024 * 1024

let file: string | null = null

function logFile(): string | null {
  if (file) return file
  try {
    const dir = join(app.getPath('userData'), 'logs')
    mkdirSync(dir, { recursive: true })
    file = join(dir, 'lyra.log')
    if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > MAX_BYTES) {
      renameSync(file, join(dir, 'lyra.old.log'))
    }
  } catch {
    file = null
  }
  return file
}

export function logPath(): string | null {
  return logFile()
}

function format(data: unknown): string {
  if (data === undefined) return ''
  if (data instanceof Error) return ` ${data.stack ?? data.message}`
  try {
    return ` ${JSON.stringify(data)}`
  } catch {
    return ` ${String(data)}`
  }
}

export function log(scope: string, message: string, data?: unknown): void {
  const line = `${new Date().toISOString()} [${scope}] ${message}${format(data)}`
  console.log(line)
  const path = logFile()
  if (!path) return
  try {
    appendFileSync(path, `${line}\n`)
  } catch {
    // Logging must never break dictation.
  }
}
