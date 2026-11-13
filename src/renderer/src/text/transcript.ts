const PROMPT_CHARS = 300

/**
 * Whisper copies the style of its prompt. On an empty page there's nothing to
 * copy, so give it a punctuated sentence to nudge it toward full punctuation.
 */
const STYLE_SEED = 'Okay, so here are my thoughts, written out in full sentences.'

const VOICE_COMMANDS: Array<[RegExp, string]> = [
  [/,?\s*\b(?:new|next) paragraph\b[.,!?]*\s*/gi, '\n\n'],
  [/,?\s*\bnew line\b[.,!?]*\s*/gi, '\n']
]

function capitalize(text: string): string {
  return text.replace(/^[a-z]/, (ch) => ch.toUpperCase())
}

/** Turns spoken formatting commands ("new paragraph") into whitespace. */
export function applyVoiceCommands(text: string): string {
  let out = text
  for (const [pattern, replacement] of VOICE_COMMANDS) out = out.replace(pattern, replacement)
  return out.replace(/\n([a-z])/g, (_match, ch: string) => `\n${ch.toUpperCase()}`)
}

/** Appends a dictated chunk to the page body with sensible spacing and capitalization. */
export function appendTranscript(body: string, chunk: string): string {
  const text = applyVoiceCommands(chunk.trim())
  // A bare "new paragraph" leaves only line breaks; never start a page with them.
  if (!text.trim()) return body.trim() ? body.trimEnd() + text : body
  if (!body.trim()) return capitalize(text.trimStart())

  const trimmed = body.trimEnd()
  const endsLine = /\n$/.test(body) || /^\n/.test(text)
  const endsSentence = /[.!?:]["')\]]?$/.test(trimmed)
  const next = endsLine || endsSentence ? capitalize(text) : text
  const attaches = endsLine || /\s$/.test(body) || /^[.,!?;:]/.test(text)
  const separator = attaches ? '' : ' '
  return `${body}${separator}${next}`
}

/**
 * Builds the context prompt for Whisper: the page title plus the tail of what
 * has been written. This keeps punctuation, casing, and vocabulary consistent
 * across utterances instead of each chunk starting from scratch.
 */
export function promptFor(title: string, body: string): string {
  const tail = body.slice(-PROMPT_CHARS).replace(/\s+/g, ' ').trim()
  const start = tail.length === PROMPT_CHARS ? tail.indexOf(' ') + 1 : 0
  const heading = title && title !== 'Untitled' ? `${title}. ` : ''
  return `${heading}${tail.slice(start)}`.trim() || STYLE_SEED
}

/**
 * Splits off a trailing "new"/"next" that might be the start of a voice command
 * whose second word ("paragraph") hasn't been committed yet.
 */
export function holdBackCommand(text: string): [ready: string, held: string] {
  const match = /\s*\b(?:new|next)$/i.exec(text)
  return match ? [text.slice(0, match.index), match[0]] : [text, '']
}
