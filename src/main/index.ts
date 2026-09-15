import { app, BrowserWindow, ipcMain, nativeImage, session, shell } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { createPage, deletePage, getPage, listPages, savePage } from './pages'
import { broadcastStatus, ensureModel, pcmFromIpc, transcribePcm } from './whisper'
import type { Page } from '../shared/types'

if (process.env.VOICE_PAGES_SMOKE === '1' || process.env.VOICE_PAGES_SCREENSHOT === '1') {
  app.setPath('userData', join(tmpdir(), `voice-pages-smoke-${process.pid}`))
}

function appIcon(): Electron.NativeImage {
  return nativeImage.createFromPath(join(__dirname, '../../build/icon.png'))
}

function createWindow(): void {
  const icon = appIcon()
  const mainWindow = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 760,
    minHeight: 520,
    show: false,
    autoHideMenuBar: true,
    title: 'Lyra',
    backgroundColor: '#f4efe6',
    ...(icon.isEmpty() ? {} : { icon }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  if (process.env.VOICE_PAGES_SMOKE !== '1') {
    mainWindow.on('ready-to-show', () => {
      mainWindow.show()
    })
  }

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  if (process.env.VOICE_PAGES_SMOKE === '1') {
    mainWindow.webContents.once('did-finish-load', () => {
      void runUiSmoke(mainWindow)
    })
  }

  if (process.env.VOICE_PAGES_SCREENSHOT === '1') {
    mainWindow.setContentSize(1280, 800)
    mainWindow.webContents.once('did-finish-load', () => {
      void captureScreenshot(mainWindow)
    })
  }
}

function registerIpc(): void {
  ipcMain.handle('pages:list', () => listPages())
  ipcMain.handle('pages:get', (_event, id: string) => getPage(id))
  ipcMain.handle('pages:create', () => createPage())
  ipcMain.handle('pages:save', (_event, page: Pick<Page, 'id' | 'title' | 'body'>) =>
    savePage(page)
  )
  ipcMain.handle('pages:delete', (_event, id: string) => deletePage(id))
  ipcMain.handle('whisper:ensureModel', () => ensureModel())
  ipcMain.handle('whisper:transcribe', async (_event, payload: unknown) => {
    return transcribePcm(pcmFromIpc(payload))
  })
}

async function seedScreenshotPages(): Promise<void> {
  const team = await createPage()
  await savePage({
    id: team.id,
    title: 'Team sync notes',
    body:
      'Quick recap from this morning.\n\n' +
      'Keep the first-run flow simple — one page, one record button. ' +
      'Ship sidebar delete before we rename the app in the UI.'
  })

  const journal = await createPage()
  await savePage({
    id: journal.id,
    title: 'Morning journal',
    body:
      'Woke up thinking about how nice it is to talk ideas out without sending audio anywhere. ' +
      'Maybe the default view should always open the latest page.'
  })

  const ideas = await createPage()
  await savePage({
    id: ideas.id,
    title: 'Product ideas',
    body:
      'Lyra should feel like a notebook, not a chatbot.\n\n' +
      'A few things worth trying next:\n' +
      '— Rename pages inline from the sidebar\n' +
      '— Keyboard shortcut for record / stop\n' +
      '— Export a page as plain text or markdown\n\n' +
      'The core loop is already good: open a page, talk, edit, copy, come back later.'
  })
}

async function captureScreenshot(win: BrowserWindow): Promise<void> {
  try {
    await seedScreenshotPages()
    await win.webContents.reload()
    await new Promise<void>((resolve) => {
      win.webContents.once('did-finish-load', () => resolve())
    })
    await new Promise((resolve) => setTimeout(resolve, 600))
    const image = await win.webContents.capturePage()
    const outDir = join(__dirname, '../../docs')
    const outPath = join(outDir, 'screenshot.png')
    await mkdir(outDir, { recursive: true })
    await writeFile(outPath, image.toPNG())
    console.log('screenshot:', outPath)
    app.exit(0)
  } catch (error) {
    console.error('screenshot failed', error)
    app.exit(1)
  }
}

async function runUiSmoke(win: BrowserWindow): Promise<void> {
  try {
    const result = await win.webContents.executeJavaScript(`
      (async () => {
        const created = await window.api.createPage()
        await window.api.savePage({ id: created.id, title: 'Smoke page', body: 'hello from smoke' })
        const loaded = await window.api.getPage(created.id)
        if (loaded.body !== 'hello from smoke') {
          throw new Error('page body did not persist')
        }
        const list = await window.api.listPages()
        if (!list.some((page) => page.id === created.id)) {
          throw new Error('page missing from list')
        }
        await window.api.deletePage(created.id)
        return 'ok'
      })()
    `)
    console.log('ui-smoke:', result)
    app.exit(0)
  } catch (error) {
    console.error('ui-smoke failed', error)
    app.exit(1)
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.voicepages.app')

  const icon = appIcon()
  if (process.platform === 'darwin' && !icon.isEmpty()) {
    app.dock?.setIcon(icon)
  }

  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    return permission === 'media' || permission === 'clipboard-sanitized-write'
  })
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media' || permission === 'clipboard-sanitized-write')
  })

  app.on('browser-window-created', (_event, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpc()
  createWindow()
  broadcastStatus({ state: 'idle' })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
