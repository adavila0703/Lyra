import { clipboard, contextBridge, ipcRenderer } from 'electron'
import type { Page, UpdateStatus, VoicePagesApi, WhisperStatus } from '../shared/types'

const api: VoicePagesApi = {
  listPages: () => ipcRenderer.invoke('pages:list'),
  getPage: (id) => ipcRenderer.invoke('pages:get', id),
  createPage: () => ipcRenderer.invoke('pages:create'),
  savePage: (page) => ipcRenderer.invoke('pages:save', page),
  deletePage: (id) => ipcRenderer.invoke('pages:delete', id),
  copyText: (text) => clipboard.writeText(text),
  platform: process.platform,
  warmUp: () => ipcRenderer.invoke('whisper:warmUp'),
  transcribe: (pcm, prompt) => ipcRenderer.invoke('whisper:transcribe', pcm, prompt),
  log: (scope, message, data) => ipcRenderer.send('log:write', scope, message, data),
  onStatus: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, status: WhisperStatus): void => {
      callback(status)
    }
    ipcRenderer.on('whisper:status', listener)
    return () => {
      ipcRenderer.removeListener('whisper:status', listener)
    }
  },
  startUpdate: () => ipcRenderer.invoke('updater:start'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  onUpdateStatus: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, status: UpdateStatus): void => {
      callback(status)
    }
    ipcRenderer.on('updater:status', listener)
    void ipcRenderer.invoke('updater:get').then((status: UpdateStatus) => {
      callback(status)
    })
    return () => {
      ipcRenderer.removeListener('updater:status', listener)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)

export type { Page }
