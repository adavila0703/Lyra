import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { autoUpdater } from 'electron-updater'
import type { UpdateStatus } from '../shared/types'

const RELEASES_URL = 'https://github.com/adavila0703/Lyra/releases'
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000

let current: UpdateStatus = { state: 'idle' }
let checkTimer: ReturnType<typeof setInterval> | null = null
let userInitiated = false

function updaterEnabled(): boolean {
  if (!app.isPackaged) return false
  if (process.env.VOICE_PAGES_SMOKE === '1' || process.env.VOICE_PAGES_SCREENSHOT === '1') {
    return false
  }
  return true
}

function macAppBundle(): string {
  return join(app.getPath('exe'), '../../..')
}

function canInstallInPlace(): boolean {
  if (process.platform !== 'darwin') return true
  const result = spawnSync('codesign', ['-dv', '--verbose=2', macAppBundle()], {
    encoding: 'utf8'
  })
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`
  return /Authority=Developer ID Application/.test(text)
}

function broadcast(status: UpdateStatus): void {
  current = status
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('updater:status', status)
  }
}

async function openReleases(): Promise<void> {
  await shell.openExternal(RELEASES_URL)
}

async function checkForUpdates(): Promise<void> {
  if (!updaterEnabled()) return
  try {
    await autoUpdater.checkForUpdates()
  } catch {
    if (userInitiated) {
      broadcast({ state: 'error', message: 'Could not check for updates.' })
    }
  }
}

export async function startUpdate(): Promise<void> {
  if (!updaterEnabled()) return
  userInitiated = true
  if (current.state === 'error' || !canInstallInPlace()) {
    await openReleases()
    return
  }
  if (current.state === 'ready') {
    autoUpdater.quitAndInstall()
    return
  }
  try {
    await autoUpdater.downloadUpdate()
  } catch {
    broadcast({ state: 'error', message: 'Could not download the update.' })
  }
}

export async function installUpdate(): Promise<void> {
  if (!updaterEnabled()) return
  if (!canInstallInPlace() || current.state !== 'ready') {
    await openReleases()
    return
  }
  autoUpdater.quitAndInstall()
}

export function registerUpdater(): void {
  ipcMain.handle('updater:start', () => startUpdate())
  ipcMain.handle('updater:install', () => installUpdate())
  ipcMain.handle('updater:get', () => current)

  if (!updaterEnabled()) return

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = false

  autoUpdater.on('update-available', (info) => {
    broadcast({ state: 'available', version: info.version })
  })
  autoUpdater.on('update-not-available', () => {
    broadcast({ state: 'idle' })
  })
  autoUpdater.on('download-progress', (progress) => {
    broadcast({ state: 'downloading', percent: Math.round(progress.percent) })
  })
  autoUpdater.on('update-downloaded', (info) => {
    broadcast({ state: 'ready', version: info.version })
  })
  autoUpdater.on('error', (error) => {
    if (!userInitiated) return
    broadcast({
      state: 'error',
      message: error instanceof Error ? error.message : 'Update failed'
    })
  })

  void checkForUpdates()
  checkTimer = setInterval(() => {
    userInitiated = false
    void checkForUpdates()
  }, CHECK_EVERY_MS)
  checkTimer.unref?.()
}
