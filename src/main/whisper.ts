import { app, BrowserWindow } from 'electron'
import { createRequire } from 'node:module'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, stat, unlink } from 'node:fs/promises'
import { arch, platform } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { finished } from 'node:stream/promises'
import type { TranscriptWord, WhisperStatus } from '../shared/types'
import { log } from './log'

const MODEL_NAME = 'ggml-base.en.bin'
const MODEL_URL =
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin'

type NativeWhisper = (
  options: Record<string, unknown>,
  callback: (error: Error | null, result: { transcription: string[][] | string[] }) => void
) => void

type TranscribeFn = (options: Record<string, unknown>) => Promise<{
  transcription: string[][] | string[]
}>

const require = createRequire(import.meta.url)
let transcribeFn: TranscribeFn | null = null

function modelsDir(): string {
  return join(app.getPath('userData'), 'models')
}

export function modelPath(): string {
  return join(modelsDir(), MODEL_NAME)
}

export function broadcastStatus(status: WhisperStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('whisper:status', status)
  }
}

function addonFolder(): string {
  const os = platform()
  const cpu = arch()
  if (os === 'darwin' && cpu === 'arm64') return 'mac-arm64'
  if (os === 'darwin') return 'mac-x64'
  if (os === 'win32') return 'win32-x64'
  if (os === 'linux' && cpu === 'arm64') return 'linux-arm64'
  return 'linux-x64'
}

function loadTranscribe(): TranscribeFn {
  if (transcribeFn) return transcribeFn

  const pkgRoot = join(require.resolve('@kutalia/whisper-node-addon/package.json'), '..')
  const addonPath = join(pkgRoot, 'dist', addonFolder(), 'whisper.node')
  const native = require(addonPath) as { whisper: NativeWhisper }
  transcribeFn = promisify(native.whisper) as TranscribeFn
  return transcribeFn
}

export async function modelExists(): Promise<boolean> {
  try {
    const info = await stat(modelPath())
    return info.size > 10_000_000
  } catch {
    return false
  }
}

export async function ensureModel(): Promise<void> {
  if (await modelExists()) return

  await mkdir(modelsDir(), { recursive: true })
  const dest = modelPath()
  const temp = `${dest}.part`

  try {
    const response = await fetch(MODEL_URL)
    if (!response.ok || !response.body) {
      throw new Error(`Failed to download Whisper model (${response.status})`)
    }

    const total = Number(response.headers.get('content-length') || 0)
    let received = 0
    broadcastStatus({ state: 'downloading', received, total })

    const file = createWriteStream(temp)
    const reader = response.body.getReader()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      broadcastStatus({ state: 'downloading', received, total })
      if (!file.write(Buffer.from(value))) {
        await new Promise<void>((resolve) => file.once('drain', resolve))
      }
    }

    file.end()
    await finished(file)
    await rename(temp, dest)
    broadcastStatus({ state: 'idle' })
  } catch (error) {
    await unlink(temp).catch(() => undefined)
    throw error
  }
}

export function pcmFromIpc(payload: unknown): Float32Array {
  let bytes: Uint8Array
  if (payload instanceof ArrayBuffer) {
    bytes = new Uint8Array(payload)
  } else if (ArrayBuffer.isView(payload)) {
    const view = payload as ArrayBufferView
    bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
  } else {
    throw new Error('Invalid audio payload from renderer')
  }

  if (bytes.byteLength % 4 !== 0) {
    throw new Error('PCM byte length is not 4-byte aligned')
  }

  const copy = new Float32Array(bytes.byteLength / 4)
  new Uint8Array(copy.buffer).set(bytes)
  return copy
}

const HALLUCINATIONS = new Set(['you', 'thank you', 'thanks for watching', 'bye', '.', '...'])

function seconds(stamp: unknown): number {
  const match = /^(\d+):(\d+):(\d+)[,.](\d+)$/.exec(String(stamp))
  if (!match) return 0
  const [, h, m, s, ms] = match.map(Number)
  return h * 3600 + m * 60 + s + ms / 1000
}

/**
 * With `max_len: 1` Whisper returns one row per token: [start, end, text].
 * Tokens that start with a space begin a new word; the rest (punctuation,
 * word pieces) attach to the previous word. Bracketed annotations such as
 * [BLANK_AUDIO] or (music) are dropped.
 */
function wordsFromTokens(result: { transcription?: unknown }): TranscriptWord[] {
  const rows = Array.isArray(result?.transcription) ? result.transcription : []
  const words: TranscriptWord[] = []
  let bracketDepth = 0

  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 3) continue
    const text = String(row[2] ?? '')
    const start = seconds(row[0])
    const end = seconds(row[1])
    const opens = (text.match(/[[(]/g) ?? []).length
    const closes = (text.match(/[\])]/g) ?? []).length
    const inside = bracketDepth > 0 || opens > 0
    bracketDepth = Math.max(0, bracketDepth + opens - closes)
    if (inside || !text.trim()) continue

    const last = words.at(-1)
    if (last && !/^\s/.test(text)) {
      last.text += text
      last.end = end
    } else {
      words.push({ text: ` ${text.trim()}`, start, end })
    }
  }
  // Whisper marks speech that runs past the end of the buffer with "..." — not dictation.
  return words
    .map((word) => ({ ...word, text: word.text.replace(/(?:\.\.\.|…)+/g, '') }))
    .filter((word) => word.text.trim())
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
}

/** Drops the stock phrases Whisper invents on silence, and echoes of its own prompt. */
function isHallucination(words: TranscriptWord[], prompt: string): boolean {
  const text = normalize(words.map((word) => word.text).join(''))
  if (!text || HALLUCINATIONS.has(text)) return true
  return text.length > 12 && normalize(prompt).includes(text)
}

const BASE_OPTIONS = {
  language: 'en',
  translate: false,
  no_timestamps: false,
  // One row per token, so the renderer gets word-level timestamps.
  max_len: 1,
  no_prints: true
}

let useGpu = true
// The native addon shares one whisper context, so calls must never overlap.
let queue: Promise<unknown> = Promise.resolve()

function runSerial<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task)
  queue = next.catch(() => undefined)
  return next
}

async function runWhisper(pcm: Float32Array, prompt: string): Promise<TranscriptWord[]> {
  const transcribe = loadTranscribe()
  const options = { ...BASE_OPTIONS, model: modelPath(), pcmf32: pcm, prompt }
  try {
    return wordsFromTokens(await transcribe({ ...options, use_gpu: useGpu }))
  } catch (gpuError) {
    if (!useGpu) throw gpuError
    log('whisper', 'GPU transcription failed, falling back to CPU', gpuError)
    useGpu = false
    return wordsFromTokens(await transcribe({ ...options, use_gpu: false }))
  }
}

let warmed: Promise<void> | null = null

/** Loads the model into memory ahead of the first real utterance (~3s cold start). */
export function warmUp(): Promise<void> {
  warmed ??= ensureModel()
    .then(() => runSerial(() => runWhisper(new Float32Array(16000), '')))
    .then(() => undefined)
    .catch((error) => {
      warmed = null
      throw error
    })
  return warmed
}

/** Transcribes 16 kHz mono PCM into words with timestamps relative to the start of `pcm`. */
export async function transcribePcm(pcm: Float32Array, prompt = ''): Promise<TranscriptWord[]> {
  if (pcm.length < 4800) return []
  await ensureModel()
  const queuedAt = Date.now()
  let startedAt = 0
  // whisper.cpp can't be cancelled, so a hung call blocks every later one; make that visible.
  const watchdog = setInterval(() => {
    log('whisper', 'transcription is taking unusually long', {
      waitedMs: Date.now() - queuedAt,
      runningMs: startedAt ? Date.now() - startedAt : 0,
      audioSec: +(pcm.length / 16000).toFixed(2)
    })
  }, 10_000)

  try {
    const words = await runSerial(() => {
      startedAt = Date.now()
      return runWhisper(pcm, prompt)
    })
    const text = words.map((word) => word.text).join('').trim()
    const dropped = isHallucination(words, prompt)
    log('whisper', dropped ? 'dropped as hallucination' : 'transcribed', {
      audioSec: +(pcm.length / 16000).toFixed(2),
      queuedMs: startedAt - queuedAt,
      runMs: Date.now() - startedAt,
      gpu: useGpu,
      promptChars: prompt.length,
      text
    })
    return dropped ? [] : words
  } catch (error) {
    log('whisper', 'transcription failed', error)
    throw error
  } finally {
    clearInterval(watchdog)
  }
}
