import type { Ref } from 'react'
import { appendTranscript } from '../text/transcript'

type Props = {
  value: string
  /** Unconfirmed dictation, drawn in place after the text. */
  ghost: string
  listening: boolean
  onChange: (value: string) => void
  ref?: Ref<HTMLTextAreaElement>
}

/**
 * A textarea layered over a mirror of its own text. The mirror sizes the field
 * to its content and draws the ghost text exactly where it will be inserted.
 */
export function Editor({ value, ghost, listening, onChange, ref }: Props) {
  const merged = ghost ? appendTranscript(value, ghost) : value
  const preview = merged.startsWith(value) ? merged.slice(value.length) : ghost

  return (
    <div className="editor-field">
      <div className="editor-mirror" aria-hidden="true">
        {value}
        <span className="ghost">{preview}</span>
        {listening ? <span className="insertion-point" /> : null}
        {'​'}
      </div>
      <textarea
        ref={ref}
        className="editor"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={
          preview || listening
            ? ''
            : 'Start talking — or typing. Your words land here and save automatically.'
        }
        aria-label="Page body"
      />
    </div>
  )
}
