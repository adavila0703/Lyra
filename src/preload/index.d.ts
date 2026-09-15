import type { VoicePagesApi } from '../shared/types'

declare global {
  interface Window {
    api: VoicePagesApi
  }
}

export {}
