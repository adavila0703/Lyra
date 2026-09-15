import { app, BrowserWindow } from 'electron'
import { createRequire } from 'node:module'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { arch, platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { finished } from 'node:stream/promises'
import type { WhisperStatus } from '../shared/types'

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

function extractText(result: { transcription?: unknown } | string[] | string[][]): string {
  const value =
    result && typeof result === 'object' && 'transcription' in result
      ? result.transcription
      : result
  if (value == null) return ''
  if (typeof value === 'string') return cleanTranscript(value)
  if (!Array.isArray(value)) return cleanTranscript(String(value))
  return cleanTranscript(
    value
      .map((row) => (Array.isArray(row) ? String(row[row.length - 1] ?? '') : String(row)))
      .join(' ')
  )
}

function cleanTranscript(text: string): string {
  const cleaned = text
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return ''
  const lower = cleaned.toLowerCase().replace(/[.?!,]+$/g, '')
  const junk = new Set(['you', 'thank you', 'thanks for watching', 'bye', 'okay', 'ok', '...', '.'])
  return junk.has(lower) ? '' : cleaned
}

function encodeWav16k(pcm: Float32Array): Buffer {
  const data = Buffer.alloc(pcm.length * 2)
  for (let i = 0; i < pcm.length; i++) {
    const sample = Math.max(-1, Math.min(1, pcm[i] ?? 0))
    data.writeInt16LE(Math.round(sample * 32767), i * 2)
  }

  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16000, 24)
  header.writeUInt32LE(32000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

function pcmStats(pcm: Float32Array): { min: number; max: number; rms: number } {
  let min = Infinity
  let max = -Infinity
  let sum = 0
  for (let i = 0; i < pcm.length; i++) {
    const value = pcm[i] ?? 0
    if (value < min) min = value
    if (value > max) max = value
    sum += value * value
  }
  return { min, max, rms: Math.sqrt(sum / Math.max(1, pcm.length)) }
}

export async function transcribePcm(pcm: Float32Array): Promise<string> {
  if (pcm.length < 6400) return ''

  await ensureModel()
  const stats = pcmStats(pcm)
  console.log(
    `pcm: n=${pcm.length} min=${stats.min.toFixed(3)} max=${stats.max.toFixed(3)} rms=${stats.rms.toFixed(3)}`
  )

  const wavPath = join(tmpdir(), `voice-pages-${randomUUID()}.wav`)
  await writeFile(wavPath, encodeWav16k(pcm))

  const transcribe = loadTranscribe()
  const options = {
    model: modelPath(),
    fname_inp: wavPath,
    language: 'en',
    translate: false,
    no_timestamps: true,
    no_prints: true,
    temperature: 0
  }

  broadcastStatus({ state: 'transcribing' })
  try {
    let result: { transcription?: unknown }
    try {
      result = await transcribe({ ...options, use_gpu: true })
    } catch (gpuError) {
      console.warn('GPU transcription failed, retrying on CPU', gpuError)
      result = await transcribe({ ...options, use_gpu: false })
    }
    const text = extractText(result)
    console.log(`whisper: ${JSON.stringify(text)}`)
    return text
  } finally {
    await unlink(wavPath).catch(() => undefined)
    broadcastStatus({ state: 'idle' })
  }
}
