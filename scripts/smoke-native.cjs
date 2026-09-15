const { app } = require('electron')
const { createRequire } = require('module')
const { join } = require('path')
const { arch, platform } = require('os')
const { mkdirSync, writeFileSync, readFileSync, rmSync } = require('fs')
const { tmpdir } = require('os')

function addonFolder() {
  const os = platform()
  const cpu = arch()
  if (os === 'darwin' && cpu === 'arm64') return 'mac-arm64'
  if (os === 'darwin') return 'mac-x64'
  if (os === 'win32') return 'win32-x64'
  if (os === 'linux' && cpu === 'arm64') return 'linux-arm64'
  return 'linux-x64'
}

app.whenReady().then(() => {
  try {
    const req = createRequire(__filename)
    const pkgRoot = join(req.resolve('@kutalia/whisper-node-addon/package.json'), '..')
    const addonPath = join(pkgRoot, 'dist', addonFolder(), 'whisper.node')
    const native = req(addonPath)
    if (typeof native.whisper !== 'function') {
      throw new Error('whisper.node did not export whisper()')
    }

    const dir = join(tmpdir(), `voice-pages-smoke-${process.pid}`)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'page.md')
    const body = `---\nid: smoke\ntitle: "Hello"\nupdatedAt: 2026-01-01T00:00:00.000Z\n---\n\nTalked this out.`
    writeFileSync(file, body, 'utf8')
    const roundTrip = readFileSync(file, 'utf8')
    if (!roundTrip.includes('Talked this out')) {
      throw new Error('markdown round-trip failed')
    }
    rmSync(dir, { recursive: true, force: true })

    console.log('ok: native whisper addon loaded for', addonFolder())
    console.log('ok: page markdown round-trip')
    app.quit()
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
})
