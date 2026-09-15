# Contributing to Lyra

Thanks for wanting to help. Lyra is a local-first voice notebook — keep PRs small and focused.

## Setup

**Requirements:** Node.js 20+ (22 recommended) and [pnpm](https://pnpm.io).

```bash
pnpm install
pnpm dev
```

On macOS, grant microphone access when prompted. The first **Record** click downloads the Whisper `base.en` model (~150 MB) into the app data folder.

## Checks

Run these before opening a pull request:

```bash
pnpm typecheck
pnpm smoke      # native Whisper addon loads in Electron
pnpm smoke:ui   # page create/save/list/delete through the UI bridge
```

## Pull requests

- One change per PR. Say why, not just what.
- Stay local-first: no cloud APIs, chat LLMs, or telemetry in v1.
- Match the existing code style. Don’t reformat unrelated files.

## Release

One command from a clean `main`:

```bash
pnpm release
```

That bumps the patch version, tags, and pushes. GitHub Actions builds the binaries and publishes the GitHub Release.

Use `pnpm release minor` or `pnpm release major` when you want those. First public cut of `0.1.0`: `pnpm release current`.

## Conduct

Be kind. This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
