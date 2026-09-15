import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page, PageSummary } from '../shared/types'

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

function pagesDir(): string {
  return join(app.getPath('userData'), 'pages')
}

function pagePath(id: string): string {
  return join(pagesDir(), `${id}.md`)
}

function previewOf(body: string): string {
  const line = body.replace(/\s+/g, ' ').trim()
  if (!line) return 'Empty page'
  return line.length > 72 ? `${line.slice(0, 72)}…` : line
}

function parseFrontmatter(block: string): Record<string, string> {
  const meta: Record<string, string> = {}
  for (const rawLine of block.split(/\r?\n/)) {
    const idx = rawLine.indexOf(':')
    if (idx === -1) continue
    const key = rawLine.slice(0, idx).trim()
    let value = rawLine.slice(idx + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      try {
        value = JSON.parse(value)
      } catch {
        value = value.slice(1, -1)
      }
    }
    meta[key] = value
  }
  return meta
}

export function serializePage(page: Page): string {
  return `---\nid: ${page.id}\ntitle: ${JSON.stringify(page.title)}\nupdatedAt: ${page.updatedAt}\n---\n\n${page.body}`
}

export function parsePage(raw: string, fallbackId: string): Page {
  const match = raw.match(FRONTMATTER)
  if (!match) {
    return {
      id: fallbackId,
      title: 'Untitled',
      body: raw,
      updatedAt: new Date().toISOString()
    }
  }

  const meta = parseFrontmatter(match[1])
  return {
    id: meta.id || fallbackId,
    title: meta.title || 'Untitled',
    updatedAt: meta.updatedAt || new Date().toISOString(),
    body: raw.slice(match[0].length).replace(/^\r?\n/, '')
  }
}

export async function ensurePagesDir(): Promise<void> {
  await mkdir(pagesDir(), { recursive: true })
}

export async function listPages(): Promise<PageSummary[]> {
  await ensurePagesDir()
  const names = await readdir(pagesDir())
  const pages: Page[] = []

  for (const name of names) {
    if (!name.endsWith('.md')) continue
    const id = name.slice(0, -3)
    const raw = await readFile(pagePath(id), 'utf8')
    pages.push(parsePage(raw, id))
  }

  pages.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

  return pages.map((page) => ({
    id: page.id,
    title: page.title,
    updatedAt: page.updatedAt,
    preview: previewOf(page.body)
  }))
}

export async function getPage(id: string): Promise<Page> {
  const raw = await readFile(pagePath(id), 'utf8')
  return parsePage(raw, id)
}

export async function createPage(): Promise<Page> {
  await ensurePagesDir()
  const page: Page = {
    id: randomUUID(),
    title: 'Untitled',
    body: '',
    updatedAt: new Date().toISOString()
  }
  await writeFile(pagePath(page.id), serializePage(page), 'utf8')
  return page
}

export async function savePage(input: Pick<Page, 'id' | 'title' | 'body'>): Promise<Page> {
  await ensurePagesDir()
  const page: Page = {
    ...input,
    updatedAt: new Date().toISOString()
  }
  await writeFile(pagePath(page.id), serializePage(page), 'utf8')
  return page
}

export async function deletePage(id: string): Promise<void> {
  await unlink(pagePath(id))
}
