import { clipboard, contextBridge, ipcRenderer } from 'electron'
import type { Page, VoicePagesApi, WhisperStatus } from '../shared/types'

const api: VoicePagesApi = {
  listPages: () => ipcRenderer.invoke('pages:list'),
  getPage: (id) => ipcRenderer.invoke('pages:get', id),
  createPage: () => ipcRenderer.invoke('pages:create'),
  savePage: (page) => ipcRenderer.invoke('pages:save', page),
  deletePage: (id) => ipcRenderer.invoke('pages:delete', id),
  copyText: (text) => clipboard.writeText(text),
  ensureModel: () => ipcRenderer.invoke('whisper:ensureModel'),
  transcribe: (pcm) => ipcRenderer.invoke('whisper:transcribe', pcm),
  onStatus: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, status: WhisperStatus): void => {
      callback(status)
    }
    ipcRenderer.on('whisper:status', listener)
    return () => {
      ipcRenderer.removeListener('whisper:status', listener)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)

export type { Page }
