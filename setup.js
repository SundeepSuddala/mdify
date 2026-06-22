#!/usr/bin/env node
/**
 * mdify setup - registers the MCP server and PreToolUse hook in Claude Code config.
 * Run once after cloning: node setup.js
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { resolve, dirname, join } from 'path'
import { homedir } from 'os'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SERVER_PATH = resolve(__dirname, 'src', 'index.js')

const CLAUDE_JSON_PATH = join(homedir(), '.claude.json')
const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json')

function readJson(path) {
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    console.error(`  ! Could not parse ${path} — skipping that file`)
    return null
  }
}

function writeJson(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8')
}

function ensureDir(path) {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function checkNodeVersion() {
  const [major] = process.versions.node.split('.').map(Number)
  if (major < 18) {
    console.error(`  ! Node.js 18+ required. You have ${process.version}.`)
    process.exit(1)
  }
}

function registerMcpServer() {
  const data = readJson(CLAUDE_JSON_PATH)
  if (data === null) return false

  const existing = data.mcpServers?.mdify
  if (existing?.args?.[0] === SERVER_PATH) {
    console.log('  - MCP server already registered (no change)')
    return true
  }

  data.mcpServers = data.mcpServers ?? {}
  data.mcpServers.mdify = {
    type: 'stdio',
    command: 'node',
    args: [SERVER_PATH]
  }

  writeJson(CLAUDE_JSON_PATH, data)
  console.log(`  + Added mcpServers.mdify -> ${SERVER_PATH}`)
  return true
}

function registerHook() {
  ensureDir(SETTINGS_PATH)
  const data = readJson(SETTINGS_PATH) ?? {}

  const hooks = (data.hooks ??= {})
  const preToolUse = (hooks.PreToolUse ??= [])

  const alreadyRegistered = preToolUse.some(
    entry =>
      entry.matcher === 'Read' &&
      entry.hooks?.some(h => h.type === 'mcp_tool' && h.server === 'mdify')
  )

  if (alreadyRegistered) {
    console.log('  - PreToolUse hook already registered (no change)')
    return true
  }

  preToolUse.push({
    matcher: 'Read',
    hooks: [
      {
        type: 'mcp_tool',
        server: 'mdify',
        tool: 'convert_to_markdown',
        timeout: 30
      }
    ]
  })

  writeJson(SETTINGS_PATH, data)
  console.log(`  + Added PreToolUse hook to ${SETTINGS_PATH}`)
  return true
}

function checkDepsInstalled() {
  const nodeModules = join(__dirname, 'node_modules', '@modelcontextprotocol', 'sdk')
  if (!existsSync(nodeModules)) {
    console.error('\n  ! Dependencies not installed. Run: npm install\n')
    process.exit(1)
  }
}

function unregisterMcpServer() {
  const data = readJson(CLAUDE_JSON_PATH)
  if (data === null) return false
  if (!data.mcpServers?.mdify) {
    console.log('  - MCP server not registered (no change)')
    return true
  }
  delete data.mcpServers.mdify
  writeJson(CLAUDE_JSON_PATH, data)
  console.log('  + Removed mcpServers.mdify')
  return true
}

function unregisterHook() {
  const data = readJson(SETTINGS_PATH)
  if (data === null || !Array.isArray(data.hooks?.PreToolUse)) {
    console.log('  - PreToolUse hook not registered (no change)')
    return true
  }

  const before = data.hooks.PreToolUse.length
  data.hooks.PreToolUse = data.hooks.PreToolUse.filter(entry => {
    const isMdify = entry.hooks?.some(h => h.type === 'mcp_tool' && h.server === 'mdify')
    return !isMdify
  })

  if (data.hooks.PreToolUse.length === before) {
    console.log('  - PreToolUse hook not registered (no change)')
    return true
  }

  // Clean up empty containers we may have emptied.
  if (data.hooks.PreToolUse.length === 0) delete data.hooks.PreToolUse
  if (Object.keys(data.hooks).length === 0) delete data.hooks

  writeJson(SETTINGS_PATH, data)
  console.log(`  + Removed PreToolUse hook from ${SETTINGS_PATH}`)
  return true
}

function install() {
  console.log('\nmdify setup\n')
  checkNodeVersion()
  checkDepsInstalled()

  console.log('Registering MCP server in ~/.claude.json ...')
  const mcpOk = registerMcpServer()

  console.log('\nRegistering PreToolUse hook in ~/.claude/settings.json ...')
  const hookOk = registerHook()

  if (mcpOk && hookOk) {
    console.log('\nDone! Restart Claude Code, then run /mcp to confirm mdify is connected.\n')
    console.log('How it works:')
    console.log('  Attach or mention any PDF, DOCX, XLSX, or CSV file in Claude Code.')
    console.log('  mdify intercepts the Read call, converts to markdown, and redirects Claude')
    console.log('  to read the compact version — transparently, with no extra steps.\n')
  } else {
    console.log('\nSetup finished with warnings. Check the messages above.\n')
  }
}

function uninstall() {
  console.log('\nmdify uninstall\n')

  console.log('Removing MCP server from ~/.claude.json ...')
  const mcpOk = unregisterMcpServer()

  console.log('\nRemoving PreToolUse hook from ~/.claude/settings.json ...')
  const hookOk = unregisterHook()

  if (mcpOk && hookOk) {
    console.log('\nDone! Restart Claude Code to apply.')
    console.log('To also clear cached conversions: rm -rf ~/.claude-md-cache\n')
  } else {
    console.log('\nUninstall finished with warnings. Check the messages above.\n')
  }
}

// --- main ---

const flag = process.argv[2]
if (flag === '--uninstall' || flag === 'uninstall') {
  uninstall()
} else if (flag === '--help' || flag === '-h') {
  console.log('\nUsage: node setup.js [--uninstall]\n')
  console.log('  (no args)     install: register the MCP server and Read hook')
  console.log('  --uninstall   remove the MCP server and Read hook\n')
} else {
  install()
}
