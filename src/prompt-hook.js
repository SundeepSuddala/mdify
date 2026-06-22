#!/usr/bin/env node
/**
 * UserPromptSubmit hook - scans the user prompt for convertible file paths,
 * converts them to markdown, and writes the result to stdout so Claude Code
 * injects the content as context before processing the prompt.
 *
 * Handles absolute paths (/path/to/file.xlsx) and home-relative paths
 * (~/Downloads/file.pdf). Bare filenames without a directory are skipped.
 */
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { isConvertible, convert } from './converter.js'
import { getCacheKey, getCached, writeCache } from './cache.js'

const FILE_PATTERN =
  /(?:~\/[^\s'"<>()[\]]+|(?:\/[^\s'"<>()[\]]+)+)\.(?:pdf|docx?|xlsx?|xls|csv)\b/gi

function expandPath(rawPath) {
  if (rawPath.startsWith('~/')) return join(homedir(), rawPath.slice(2))
  return rawPath
}

async function main() {
  let input = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) input += chunk

  let prompt = ''
  try {
    const event = JSON.parse(input)
    prompt = event.prompt ?? ''
  } catch {
    process.exit(0)
  }

  const rawMatches = prompt.match(FILE_PATTERN) ?? []
  const paths = [...new Set(rawMatches)]
  if (paths.length === 0) process.exit(0)

  const blocks = []

  for (const rawPath of paths) {
    const filePath = expandPath(rawPath)
    if (!existsSync(filePath)) continue
    if (!isConvertible(filePath)) continue

    const key = getCacheKey(filePath)
    if (!key) continue

    const cached = getCached(key)
    if (cached) {
      try {
        blocks.push(readFileSync(cached, 'utf8'))
      } catch {}
      continue
    }

    try {
      const markdown = await convert(filePath)
      writeCache(key, markdown)
      blocks.push(markdown)
    } catch {
      // pass-through: file could not be converted
    }
  }

  if (blocks.length > 0) {
    process.stdout.write(blocks.join('\n\n---\n\n'))
  }
}

main().catch(() => process.exit(0))