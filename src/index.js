import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { existsSync } from 'fs'
import { resolve, join } from 'path'
import { homedir } from 'os'
import { isConvertible, convert } from './converter.js'
import { getCacheKey, getCached, writeCache, pruneStaleCache } from './cache.js'

function log(msg) {
  process.stderr.write(`[mdify] ${msg}\n`)
}

function expandPath(rawPath) {
  if (rawPath.startsWith('~/')) return join(homedir(), rawPath.slice(2))
  if (rawPath === '~') return homedir()
  return resolve(rawPath)
}

const server = new Server(
  { name: 'mdify', version: '1.0.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'convert_to_markdown',
      description:
        'Called automatically by the PreToolUse hook when Claude Code reads a file. ' +
        'Converts PDF, DOCX, XLSX, and CSV files to compact markdown before they enter ' +
        'the context window, reducing token usage by up to 98%.',
      inputSchema: {
        type: 'object',
        properties: {
          tool_input: {
            type: 'object',
            description: 'The hook event tool_input payload from Claude Code',
            properties: {
              file_path: { type: 'string', description: 'Path of the file being read' }
            }
          }
        }
      }
    }
  ]
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'convert_to_markdown') {
    throw new Error(`Unknown tool: ${request.params.name}`)
  }

  const rawPath = request.params.arguments?.tool_input?.file_path
  if (!rawPath) return passThrough()

  const filePath = expandPath(rawPath)

  if (!existsSync(filePath)) return passThrough()
  if (!isConvertible(filePath)) return passThrough()

  const key = getCacheKey(filePath)
  if (!key) return passThrough()

  const cached = getCached(key)
  if (cached) {
    log(`cache hit: ${filePath}`)
    return redirect(cached)
  }

  try {
    const mdPath = await convertOnce(key, filePath)
    return redirect(mdPath)
  } catch (err) {
    log(`conversion failed (pass-through): ${err.message}`)
    return passThrough()
  }
})

// Coalesce concurrent conversions of the same file: the second Read of an uncached
// file awaits the first conversion instead of starting its own.
const inFlight = new Map()

function convertOnce(key, filePath) {
  const pending = inFlight.get(key)
  if (pending) {
    log(`awaiting in-flight conversion: ${filePath}`)
    return pending
  }

  const task = (async () => {
    log(`converting: ${filePath}`)
    const markdown = await convert(filePath)
    const mdPath = writeCache(key, markdown)
    log(`converted -> ${mdPath}`)
    return mdPath
  })().finally(() => inFlight.delete(key))

  inFlight.set(key, task)
  return task
}

function passThrough() {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow'
        }
      })
    }]
  }
}

function redirect(mdPath) {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: { file_path: mdPath }
        }
      })
    }]
  }
}

process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))

pruneStaleCache()

const transport = new StdioServerTransport()
try {
  await server.connect(transport)
  log('server running')
} catch (err) {
  log(`failed to start: ${err.message}`)
  process.exit(1)
}
