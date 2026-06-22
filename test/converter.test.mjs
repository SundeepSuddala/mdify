import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { convert, isConvertible } from '../src/converter.js'

const dir = mkdtempSync(join(tmpdir(), 'mdify-test-'))
process.on('exit', () => rmSync(dir, { recursive: true, force: true }))

function fixture(name, content) {
  const p = join(dir, name)
  writeFileSync(p, content)
  return p
}

test('isConvertible: accepts supported extensions, rejects others', () => {
  assert.equal(isConvertible(fixture('a.csv', 'x')), true)
  assert.equal(isConvertible(fixture('a.pdf', 'x')), true)
  assert.equal(isConvertible(fixture('a.txt', 'x')), false)
  assert.equal(isConvertible(fixture('a.md', 'x')), false)
  assert.equal(isConvertible('/no/such/file.csv'), false)
})

test('CSV: escapes pipes, preserves quoted commas, pads ragged rows, flattens newlines', async () => {
  const p = fixture('t.csv', 'name,note,amount\n"Smith, J.","has | pipe",100\nRagged\n"multi\nline","ok",5\n')
  const md = await convert(p)
  assert.match(md, /^<!-- mdify \| source:/, 'has mdify header')
  assert.match(md, /has \\\| pipe/, 'pipe is escaped')
  assert.match(md, /Smith, J\./, 'quoted comma preserved as one cell')
  assert.match(md, /multi line/, 'newline inside cell flattened to space')
  // ragged row "Ragged" should still produce a 3-column row
  const raggedLine = md.split('\n').find(l => l.includes('Ragged'))
  assert.equal((raggedLine.match(/\|/g) || []).length, 4, 'ragged row padded to full column count')
})

test('CSV: empty file does not throw and is labelled', async () => {
  const p = fixture('empty.csv', '')
  const md = await convert(p)
  assert.match(md, /empty file/i)
})

test('XLSX: ragged sheet renders a rectangular table', async () => {
  const require = createRequire(import.meta.url)
  const XLSX = require('xlsx')
  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.aoa_to_sheet([['a', 'b'], ['x', 'y', 'z|extra'], ['lonely']])
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')
  const p = join(dir, 't.xlsx')
  XLSX.writeFile(wb, p)

  const md = await convert(p)
  assert.match(md, /## Sheet1/, 'sheet name becomes a heading')
  assert.match(md, /z\\\|extra/, 'pipe in a wider-than-header row is escaped')
  // every table row must have the same number of column separators
  const rows = md.split('\n').filter(l => l.trim().startsWith('|'))
  const pipeCounts = new Set(rows.map(l => (l.match(/(?<!\\)\|/g) || []).length))
  assert.equal(pipeCounts.size, 1, 'all table rows have equal column count')
})

test('convert: unsupported extension throws', async () => {
  await assert.rejects(() => convert('/tmp/x.png'), /Unsupported/)
})
