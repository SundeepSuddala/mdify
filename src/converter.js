import { readFileSync, statSync } from 'fs'
import { extname, basename } from 'path'

const CONVERTIBLE_EXTENSIONS = new Set(['.pdf', '.docx', '.doc', '.xlsx', '.xls', '.csv'])
const MAX_INPUT_BYTES = 50 * 1024 * 1024
const MAX_OUTPUT_CHARS = 200_000

export function isConvertible(filePath) {
  try {
    const stat = statSync(filePath)
    if (stat.size > MAX_INPUT_BYTES) return false
    return CONVERTIBLE_EXTENSIONS.has(extname(filePath).toLowerCase())
  } catch {
    return false
  }
}

function buildHeader(filePath, outputChars) {
  try {
    const stat = statSync(filePath)
    const sizeKb = (stat.size / 1024).toFixed(1)
    const approxTokens = Math.round(outputChars / 4)
    return `<!-- mdify | source: ${filePath} | original: ${sizeKb} KB | ~${approxTokens} tokens -->\n\n`
  } catch {
    return `<!-- mdify | source: ${filePath} -->\n\n`
  }
}

function truncate(text) {
  if (text.length <= MAX_OUTPUT_CHARS) return text
  const truncated = text.slice(0, MAX_OUTPUT_CHARS)
  return truncated + `\n\n<!-- mdify: output truncated at ${MAX_OUTPUT_CHARS} chars -->`
}

// Cell content must not break the markdown table: pipes are escaped, newlines
// and tabs collapse to spaces. Returns a single-line, table-safe string.
function cleanCell(value) {
  return String(value ?? '')
    .replace(/\r?\n|\r|\t/g, ' ')
    .replace(/\|/g, '\\|')
    .trim()
}

// Render a rectangular array of rows (first row = header) as a padded markdown table.
function renderTable(rows) {
  const colCount = Math.max(0, ...rows.map(r => r.length))
  if (colCount === 0) return ''
  const grid = rows.map(r => Array.from({ length: colCount }, (_, i) => cleanCell(r[i])))
  const colWidths = Array.from({ length: colCount }, (_, i) =>
    Math.max(3, ...grid.map(r => r[i].length))
  )
  const fmt = row => '| ' + row.map((cell, i) => cell.padEnd(colWidths[i])).join(' | ') + ' |'
  const sep = '| ' + colWidths.map(w => '-'.repeat(w)).join(' | ') + ' |'
  return [fmt(grid[0]), sep, ...grid.slice(1).map(fmt)].join('\n')
}

// Import the lib entry directly, not the package root. pdf-parse's index.js runs
// a debug block on load that reads a bundled test PDF relative to cwd, which
// throws ENOENT under ESM (module.parent is undefined). The lib entry has no such block.
async function convertPdf(filePath) {
  const { default: pdfParse } = await import('pdf-parse/lib/pdf-parse.js')
  const buffer = readFileSync(filePath)
  const data = await pdfParse(buffer)
  const text = data.text.trim()
  const body = text
    ? `# ${basename(filePath)}\n\n${text}`
    : `# ${basename(filePath)}\n\n_(No extractable text. This PDF is likely scanned/image-only; mdify does not OCR.)_`
  const truncated = truncate(body)
  return buildHeader(filePath, truncated.length) + truncated
}

async function convertDocx(filePath) {
  const mammoth = await import('mammoth')
  const result = await mammoth.convertToMarkdown({ path: filePath })
  const body = `# ${basename(filePath)}\n\n${result.value.trim()}`
  const truncated = truncate(body)
  return buildHeader(filePath, truncated.length) + truncated
}

async function convertXlsx(filePath) {
  const XLSX = await import('xlsx')
  const wb = XLSX.default.readFile(filePath)
  let body = `# ${basename(filePath)}\n\n`

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName]
    const rows = XLSX.default.utils.sheet_to_json(ws, { header: 1, defval: '' })
    if (rows.length === 0) continue

    body += `## ${sheetName}\n\n`
    body += renderTable(rows) + '\n\n'
  }

  const truncated = truncate(body.trim())
  return buildHeader(filePath, truncated.length) + truncated
}

function parseCsvRows(text) {
  const rows = []
  let row = []
  let cell = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        cell += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (ch === ',' && !inQuotes) {
      row.push(cell)
      cell = ''
    } else if ((ch === '\n' || (ch === '\r' && text[i + 1] === '\n')) && !inQuotes) {
      if (ch === '\r') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else {
      cell += ch
    }
  }
  if (cell || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

function convertCsv(filePath) {
  const text = readFileSync(filePath, 'utf8').trim()
  const rows = parseCsvRows(text)
  if (rows.length === 0) {
    const header = buildHeader(filePath, 0)
    return header + `# ${basename(filePath)}\n\n(empty file)`
  }

  const body = `# ${basename(filePath)}\n\n${renderTable(rows)}`
  const truncated = truncate(body.trim())
  return buildHeader(filePath, truncated.length) + truncated
}

export async function convert(filePath) {
  const ext = extname(filePath).toLowerCase()
  switch (ext) {
    case '.pdf':          return convertPdf(filePath)
    case '.docx':
    case '.doc':          return convertDocx(filePath)
    case '.xlsx':
    case '.xls':          return convertXlsx(filePath)
    case '.csv':          return convertCsv(filePath)
    default:              throw new Error(`Unsupported: ${ext}`)
  }
}
