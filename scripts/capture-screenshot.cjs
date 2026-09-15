const { spawnSync } = require('node:child_process')
const electron = require('electron')

process.env.VOICE_PAGES_SCREENSHOT = '1'
const result = spawnSync(electron, ['.'], {
  cwd: require('node:path').join(__dirname, '..'),
  env: process.env,
  stdio: 'inherit'
})

process.exit(result.status ?? 1)
