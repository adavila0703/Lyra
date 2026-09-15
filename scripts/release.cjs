const { spawnSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
const bump = process.argv[2] || 'patch'
const allowed = new Set(['patch', 'minor', 'major', 'current'])

if (!allowed.has(bump)) {
  console.error('Usage: pnpm release [patch|minor|major|current]')
  process.exit(1)
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    cwd: root,
    stdio: opts.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8'
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
  return result.stdout?.trim() ?? ''
}

function packageVersion() {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
}

const status = run('git', ['status', '--porcelain'], { capture: true })
if (status) {
  console.error('Working tree is dirty. Commit or stash first.')
  process.exit(1)
}

if (bump === 'current') {
  const version = packageVersion()
  const tag = `v${version}`
  const existing = spawnSync('git', ['rev-parse', tag], { cwd: root, stdio: 'pipe' })
  if (existing.status === 0) {
    console.error(`Tag ${tag} already exists.`)
    process.exit(1)
  }
  run('git', ['tag', '-a', tag, '-m', `chore: release ${tag}`])
  console.log(`Tagged ${tag} (no version bump)`)
} else {
  run('pnpm', ['version', bump, '--no-git-checks', '-m', 'chore: release %s'])
  console.log(`Bumped to v${packageVersion()}`)
}

run('git', ['push', 'origin', 'HEAD', '--follow-tags'])
console.log('Pushed. GitHub Actions will build the binaries and publish the release.')
