import type { TranscriptWord } from '../../../shared/types'
import { log } from '../lib/log'
import { SAMPLE_RATE } from './vad'

/**
 * Streaming transcription with the LocalAgreement-2 policy from
 * Macháček et al., "Turning Whisper into Real-Time Transcription System" (2023).
 *
 * Whisper is re-run over a growing audio buffer every half second or so. A word
 * is committed only once two consecutive passes agree on it, and not while it
 * is the newest word heard: Whisper's guess at the trailing word (its casing,
 * punctuation, and timing) is the least reliable. The exception is a trailing
 * word both passes heard identically as a sentence end. Committed text is stable;
 * everything after it is shown as an unconfirmed "live" tail.
 *
 * Whisper sees whole sentences rather than pause-delimited fragments, so it
 * punctuates and capitalizes properly. Once a sentence is committed, the audio
 * up to its last word is trimmed from the buffer and its text moves into the
 * prompt, so each pass stays short and still has the preceding context.
 */

/** New audio required before another pass. Lower is snappier but costs more compute. */
const STEP = 0.5 * SAMPLE_RATE
/** Don't trim shorter buffers: Whisper needs some audio context to stay accurate. */
const MIN_TRIM = 2 * SAMPLE_RATE
/**
 * Past this length, stop waiting for agreement or a sentence end: commit what
 * Whisper heard and trim. Long buffers make every pass slower and give Whisper
 * room to loop or go silent, which would stall dictation.
 */
const MAX_BUFFER = 15 * SAMPLE_RATE
/** How many committed words to match when aligning a new pass, and how far they may drift. */
const ALIGN_WORDS = 3
const ALIGN_DRIFT = 4
/** Timestamp fallback when text alignment fails. */
const TIMESTAMP_SLACK = 0.1
const CONTEXT_CHARS = 300

const SENTENCE_END = /[.!?]["')\]]?$/

type Transcribe = (pcm: Float32Array, prompt: string) => Promise<TranscriptWord[]>

export type StreamEvents = {
  /** Text that is now final, to append to the document. */
  onCommit: (text: string) => void
  /** The unconfirmed tail; replaces the previous live text. */
  onLive: (text: string) => void
  onError: (error: unknown) => void
}

const secs = (samples: number): number => +(samples / SAMPLE_RATE).toFixed(2)

export type StreamStats = {
  bufferSec: number
  committedWords: number
  tentativeWords: number
  /** How long the current pass has been running, or 0. */
  passMs: number
  passes: number
}

const joinWords = (words: TranscriptWord[]): string => words.map((word) => word.text).join('')

const wordKey = (word: TranscriptWord): string => word.text.toLowerCase().replace(/[^a-z0-9']/g, '')

function agreedPrefix(a: TranscriptWord[], b: TranscriptWord[]): number {
  let n = 0
  while (n < a.length && n < b.length && wordKey(a[n]) === wordKey(b[n])) n++
  return n
}

export class StreamingTranscriber {
  private chunks: Float32Array[] = []
  private length = 0
  /** Absolute sample index of the start of the buffer. */
  private offset = 0
  private sinceLastPass = 0
  private passQueued = false
  /** Committed words whose audio is still in the buffer (absolute seconds). */
  private committed: TranscriptWord[] = []
  private lastCommittedEnd = 0
  /** The previous pass's words after the committed ones. */
  private tentative: TranscriptWord[] = []
  private work: Promise<void> = Promise.resolve()
  private passStartedAt = 0
  private passes = 0

  constructor(
    private readonly transcribe: Transcribe,
    private readonly events: StreamEvents,
    /** Text that precedes this session, e.g. the end of the page. */
    private context = ''
  ) {}

  append(frame: Float32Array): void {
    this.chunks.push(frame)
    this.length += frame.length
    this.sinceLastPass += frame.length
    if (this.sinceLastPass >= STEP && !this.passQueued) {
      this.passQueued = true
      this.enqueue(() => {
        this.passQueued = false
        return this.pass()
      }).catch(this.events.onError)
    }
  }

  /** Commits everything heard so far (after a long pause, or when stopping). */
  finalize(): Promise<void> {
    const end = this.offset + this.length
    return this.enqueue(() => this.pass(end))
  }

  stats(): StreamStats {
    return {
      bufferSec: secs(this.length),
      committedWords: this.committed.length,
      tentativeWords: this.tentative.length,
      passMs: this.passStartedAt ? Date.now() - this.passStartedAt : 0,
      passes: this.passes
    }
  }

  /** Resolves once all queued passes have finished. */
  idle(): Promise<void> {
    return this.work
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.work.then(task)
    this.work = next.catch(() => undefined)
    return next
  }

  /** One transcription pass. With `finalizeAt`, everything up to that sample is committed. */
  private async pass(finalizeAt?: number): Promise<void> {
    const end = finalizeAt === undefined ? this.length : finalizeAt - this.offset
    this.sinceLastPass = 0
    if (end <= 0) {
      this.events.onLive('')
      return
    }

    const base = this.offset / SAMPLE_RATE
    // Whisper pads input to 30 s, so on short clips it can time the last word
    // well past the real audio. A bogus end would outlive the trim and make the
    // timestamp fallback in `unseen` discard everything said afterwards.
    const limit = base + end / SAMPLE_RATE
    const overdue = finalizeAt === undefined && this.length >= MAX_BUFFER
    this.passStartedAt = Date.now()
    this.passes++
    let heard: TranscriptWord[]
    try {
      heard = (await this.transcribe(this.audio(end), this.prompt())).map((word) => ({
        ...word,
        start: Math.min(word.start + base, limit),
        end: Math.min(word.end + base, limit)
      }))
    } finally {
      this.passStartedAt = 0
    }
    const words = this.unseen(heard)

    let agreed: number
    if (finalizeAt !== undefined) agreed = words.length
    else if (overdue) agreed = Math.max(0, words.length - 1)
    else agreed = this.agreed(words)
    agreed = Math.max(0, agreed)

    const committed = words.slice(0, agreed)
    this.commit(committed)
    this.tentative = words.slice(agreed)
    this.events.onLive(joinWords(this.tentative))

    log('stream', finalizeAt !== undefined ? 'finalize pass' : overdue ? 'overdue pass' : 'pass', {
      bufferSec: secs(end),
      heard: heard.length,
      fresh: words.length,
      committed: joinWords(committed).trim(),
      live: joinWords(this.tentative).trim()
    })

    if (finalizeAt !== undefined) this.trimTo(finalizeAt)
    else if (overdue && !this.committed.length) {
      // Whisper heard (almost) nothing in a long stretch: keep only the recent audio.
      log('stream', 'nothing usable in a full buffer; discarding old audio', { bufferSec: secs(end) })
      this.trimTo(this.offset + this.length - MIN_TRIM)
    } else this.trimAtSentence()
  }

  /**
   * How many of this pass's words both passes agree on. The newest word is held
   * back, unless both passes heard it identically as the end of a sentence:
   * otherwise the sentence end only commits once more speech follows, and by
   * then Whisper has often rewritten it ("years." → "years, and"), so the
   * buffer never trims at a sentence and grows to MAX_BUFFER.
   */
  private agreed(words: TranscriptWord[]): number {
    const n = agreedPrefix(this.tentative, words)
    if (n === 0 || n < words.length) return n
    const last = words[n - 1]
    const sameEnd = SENTENCE_END.test(last.text) && this.tentative[n - 1].text === last.text
    return sameEnd ? n : n - 1
  }

  private commit(words: TranscriptWord[]): void {
    if (!words.length) return
    this.committed.push(...words)
    this.lastCommittedEnd = words.at(-1)!.end
    this.events.onCommit(joinWords(words))
  }

  /**
   * Drops the words this pass re-transcribed from audio that was already
   * committed. Each pass covers the whole buffer, so it starts with the
   * committed words still in it; find where they end by matching text.
   * whisper.cpp's token timestamps jitter too much between passes to rely on.
   */
  private unseen(words: TranscriptWord[]): TranscriptWord[] {
    const done = this.committed.length
    if (!done) return words

    for (let n = Math.min(ALIGN_WORDS, done); n > 0; n--) {
      const tail = this.committed.slice(-n).map(wordKey).join(' ')
      // Search outward from where the committed words should end.
      for (let shift = 0; shift <= ALIGN_DRIFT; shift++) {
        for (const end of shift ? [done + shift, done - shift] : [done]) {
          if (end < n || end > words.length) continue
          if (words.slice(end - n, end).map(wordKey).join(' ') !== tail) continue
          this.recoverPunctuation(words[end - 1])
          return words.slice(end)
        }
      }
    }

    log('stream', 'text alignment failed; falling back to timestamps', {
      committedTail: joinWords(this.committed.slice(-ALIGN_WORDS)).trim(),
      heard: joinWords(words).trim()
    })
    return words.filter((word) => word.start > this.lastCommittedEnd - TIMESTAMP_SLACK)
  }

  /**
   * A word may be committed before Whisper knows the sentence ends there
   * ("again" → later "again."). Commit the late punctuation on its own.
   */
  private recoverPunctuation(retranscribed: TranscriptWord): void {
    const last = this.committed.at(-1)!
    // Only sentence ends: a late comma is usually Whisper hedging, not structure.
    const added = /[.!?]+$/.exec(retranscribed.text)?.[0]
    if (!added || /[.,!?;:]$/.test(last.text)) return
    last.text += added
    this.events.onCommit(added)
  }

  /**
   * Trims the buffer after the latest committed sentence. The cut goes at the
   * start of the following word: the trailing word's end timestamp is often
   * stretched to the end of the audio, and cutting there would lose speech.
   */
  private trimAtSentence(): void {
    if (this.length < MIN_TRIM) return

    const words = [...this.committed, ...this.tentative]
    const last = this.committed.findLastIndex((word) => SENTENCE_END.test(word.text))
    const boundary =
      last >= 0 ? last : this.length >= MAX_BUFFER ? this.committed.length - 1 : -1
    const next = words[boundary + 1]
    if (boundary < 0 || !next) return

    const cut = Math.min(words[boundary].end, next.start)
    const before = this.length
    this.trimTo(Math.round(cut * SAMPLE_RATE))
    log('stream', last >= 0 ? 'trimmed at sentence' : 'trimmed at word (buffer full)', {
      fromSec: secs(before),
      toSec: secs(this.length)
    })
  }

  /** Discards audio before `sample` and moves the committed words it held into the prompt. */
  private trimTo(sample: number): void {
    let drop = Math.min(Math.max(0, sample - this.offset), this.length)
    this.offset += drop
    this.length -= drop
    while (drop > 0) {
      const head = this.chunks[0]
      if (head.length <= drop) {
        this.chunks.shift()
        drop -= head.length
      } else {
        this.chunks[0] = head.subarray(drop)
        drop = 0
      }
    }

    const cut = this.offset / SAMPLE_RATE + 0.01
    const gone = this.committed.filter((word) => word.end <= cut)
    this.committed = this.committed.slice(gone.length)
    this.tentative = this.tentative.filter((word) => word.start >= cut)
    this.context = (this.context + joinWords(gone)).slice(-CONTEXT_CHARS * 2)
  }

  private audio(samples: number): Float32Array {
    const out = new Float32Array(samples)
    let written = 0
    for (const chunk of this.chunks) {
      if (written >= samples) break
      const part = chunk.subarray(0, samples - written)
      out.set(part, written)
      written += part.length
    }
    return out
  }

  /** The text scrolled out of the buffer, trimmed to whole words. */
  private prompt(): string {
    const text = this.context.replace(/\s+/g, ' ').trim()
    if (text.length <= CONTEXT_CHARS) return text
    const tail = text.slice(-CONTEXT_CHARS)
    return tail.slice(tail.indexOf(' ') + 1)
  }
}
