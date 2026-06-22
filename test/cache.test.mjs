import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dir = mkdtempSync(join(tmpdir(), 'mdify-cache-'))
process.on('exit', () => rmSync(dir, { recursive: true, force: true }))

// Point the cache at a temp dir BEFORE importing cache.js, which reads the env at load.
process.env.MDIFY_CACHE_DIR = join(dir, 'cache')
const { getCacheKey, getCached, writeCache } = await import('../src/cache.js')

test('getCacheKey: null for missing file, stable for same mtime, changes when mtime changes', () => {
  assert.equal(getCacheKey('/no/such/file'), null)

  const p = join(dir, 'f.csv')
  writeFileSync(p, 'a,b\n1,2\n')
  const k1 = getCacheKey(p)
  assert.equal(k1, getCacheKey(p), 'same file + mtime => same key')

  const future = new Date(Date.now() + 10_000)
  utimesSync(p, future, future)
  assert.notEqual(k1, getCacheKey(p), 'changed mtime => different key (auto-invalidation)')
})

test('writeCache then getCached round-trips the same path', () => {
  const key = 'deadbeef'.repeat(8)
  const out = writeCache(key, '# hello\n')
  assert.equal(getCached(key), out, 'getCached returns the written path')
})

test('getCached returns null for an unknown key', () => {
  assert.equal(getCached('f'.repeat(64)), null)
})
