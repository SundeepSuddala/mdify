import { createHash, randomBytes } from 'crypto'
import { writeFileSync, mkdirSync, statSync, existsSync, readdirSync, unlinkSync, renameSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const CACHE_DIR = process.env.MDIFY_CACHE_DIR || join(homedir(), '.claude-md-cache')
const STALE_MS = 7 * 24 * 60 * 60 * 1000

export function ensureCacheDir() {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true })
}

export function getCacheKey(filePath) {
  try {
    const stat = statSync(filePath)
    return createHash('sha256').update(`${filePath}:${stat.mtimeMs}`).digest('hex')
  } catch {
    return null
  }
}

export function getCached(key) {
  if (!key) return null
  const cachePath = join(CACHE_DIR, `${key}.md`)
  if (existsSync(cachePath)) return cachePath
  return null
}

export function writeCache(key, content) {
  ensureCacheDir()
  const cachePath = join(CACHE_DIR, `${key}.md`)
  // Write to a unique temp file then atomically rename into place, so a crash or a
  // concurrent reader never sees a half-written cache entry. The unique suffix keeps
  // two simultaneous conversions of the same file from clobbering each other's temp.
  const tmpPath = `${cachePath}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(tmpPath, content, 'utf8')
    renameSync(tmpPath, cachePath)
  } catch (err) {
    try { unlinkSync(tmpPath) } catch {}
    throw err
  }
  return cachePath
}

export function pruneStaleCache() {
  if (!existsSync(CACHE_DIR)) return
  const now = Date.now()
  try {
    for (const file of readdirSync(CACHE_DIR)) {
      if (!file.endsWith('.md')) continue
      const fullPath = join(CACHE_DIR, file)
      try {
        const { mtimeMs } = statSync(fullPath)
        if (now - mtimeMs > STALE_MS) unlinkSync(fullPath)
      } catch {}
    }
  } catch {}
}
