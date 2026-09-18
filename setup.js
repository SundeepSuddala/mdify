#!/usr/bin/env node
/**
 * mdify setup - registers the MCP server and PreToolUse hook in Claude Code config.
 * Run once after cloning: node setup.js
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { resolve, dirname, join } from 'path'
import { homedir } from 'os'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SERVER_PATH = resolve(__dirname, 'src', 'index.js')
const PROMPT_HOOK_PATH = resolve(__dirname, 'src', 'prompt-hook.js')
const PROMPT_HOOK_COMMAND = `${process.execPath} ${PROMPT_HOOK_PATH}`

const CLAUDE_JSON_PATH = join(homedir(), '.claude.json')
const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json')

const MDIFY_PORT = Number(process.env.MDIFY_PORT || 7201)
const MDIFY_URL = `http://localhost:${MDIFY_PORT}/mcp`
const PLIST_LABEL = 'com.mdify.server'
const PLIST_TEMPLATE_PATH = resolve(__dirname, 'launchd', `${PLIST_LABEL}.plist.template`)
const PLIST_DEST_PATH = join(homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`)
const LOG_DIR = join(homedir(), 'Library', 'Logs')

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

function hasClaudeCli() {
  try {
    execSync('claude --version', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function startLaunchdService() {
  if (process.platform !== 'darwin') {
    console.log('  - launchd is macOS-only; skipping background service.')
    console.log(`    Run manually: ${process.execPath} ${SERVER_PATH} --transport streamable-http --host localhost --port ${MDIFY_PORT}`)
    return true
  }

  if (!existsSync(PLIST_TEMPLATE_PATH)) {
    console.error(`  ! Missing launchd template: ${PLIST_TEMPLATE_PATH}`)
    return false
  }

  ensureDir(PLIST_DEST_PATH)
  mkdirSync(LOG_DIR, { recursive: true })

  const template = readFileSync(PLIST_TEMPLATE_PATH, 'utf8')
  const nodeDir = dirname(process.execPath)
  const rendered = template
    .replaceAll('__NODE__', process.execPath)
    .replaceAll('__SERVER_JS__', SERVER_PATH)
    .replaceAll('__WORKDIR__', __dirname)
    .replaceAll('__PORT__', String(MDIFY_PORT))
    .replaceAll('__EXTRA_PATH__', nodeDir)
    .replaceAll('__LOG_DIR__', LOG_DIR)

  writeFileSync(PLIST_DEST_PATH, rendered, 'utf8')

  const uid = execSync('id -u').toString().trim()
  try {
    execSync(`launchctl bootout gui/${uid} ${PLIST_DEST_PATH}`, { stdio: 'ignore' })
  } catch {
    // not loaded yet - fine
  }
  execSync(`launchctl bootstrap gui/${uid} ${PLIST_DEST_PATH}`)

  console.log(`  + Service running: ${PLIST_LABEL} -> ${MDIFY_URL}`)
  console.log(`    Logs: ${join(LOG_DIR, 'mdify.log')}`)
  return true
}

function stopLaunchdService() {
  if (process.platform !== 'darwin') return true
  const uid = execSync('id -u').toString().trim()
  try {
    execSync(`launchctl bootout gui/${uid} ${PLIST_DEST_PATH}`, { stdio: 'ignore' })
    console.log(`  + Stopped and unloaded ${PLIST_LABEL}`)
  } catch {
    console.log(`  - ${PLIST_LABEL} not loaded (no change)`)
  }
  return true
}

function registerMcpServer() {
  if (hasClaudeCli()) {
    const listed = execSync('claude mcp list', { stdio: ['ignore', 'pipe', 'ignore'] }).toString()
    if (listed.includes('mdify')) {
      console.log('  - MCP server already registered (no change)')
      return true
    }
    execSync(`claude mcp add --transport http mdify ${MDIFY_URL} -s user`, { stdio: 'inherit' })
    console.log(`  + Registered via 'claude mcp add' (http, ${MDIFY_URL})`)
    return true
  }

  // Fallback: merge directly into ~/.claude.json
  console.error("  ! 'claude' CLI not found - falling back to direct ~/.claude.json edit.")
  const data = readJson(CLAUDE_JSON_PATH)
  if (data === null) return false

  const existing = data.mcpServers?.mdify
  if (existing?.url === MDIFY_URL) {
    console.log('  - MCP server already registered (no change)')
    return true
  }

  data.mcpServers = data.mcpServers ?? {}
  data.mcpServers.mdify = { type: 'http', url: MDIFY_URL }

  writeJson(CLAUDE_JSON_PATH, data)
  console.log(`  + Added mcpServers.mdify -> ${MDIFY_URL}`)
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

function unregisterPromptHook() {
  const data = readJson(SETTINGS_PATH)
  if (data === null || !Array.isArray(data.hooks?.UserPromptSubmit)) {
    console.log('  - UserPromptSubmit hook not registered (no change)')
    return true
  }

  const before = data.hooks.UserPromptSubmit.length
  data.hooks.UserPromptSubmit = data.hooks.UserPromptSubmit.filter(
    entry => !entry.hooks?.some(h => h.type === 'command' && h.command === PROMPT_HOOK_COMMAND)
  )

  if (data.hooks.UserPromptSubmit.length === before) {
    console.log('  - UserPromptSubmit hook not registered (no change)')
    return true
  }

  if (data.hooks.UserPromptSubmit.length === 0) delete data.hooks.UserPromptSubmit
  if (Object.keys(data.hooks).length === 0) delete data.hooks

  writeJson(SETTINGS_PATH, data)
  console.log(`  + Removed UserPromptSubmit hook from ${SETTINGS_PATH}`)
  return true
}

function unregisterMcpServer() {
  if (hasClaudeCli()) {
    try {
      execSync('claude mcp remove mdify -s user', { stdio: 'ignore' })
      console.log('  + Removed mdify via claude mcp remove')
      return true
    } catch {
      // not registered via CLI scope - fall through to direct edit
    }
  }

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

function registerPromptHook() {
  ensureDir(SETTINGS_PATH)
  const data = readJson(SETTINGS_PATH) ?? {}

  const hooks = (data.hooks ??= {})
  const userPromptSubmit = (hooks.UserPromptSubmit ??= [])

  const alreadyRegistered = userPromptSubmit.some(
    entry => entry.hooks?.some(h => h.type === 'command' && h.command === PROMPT_HOOK_COMMAND)
  )

  if (alreadyRegistered) {
    console.log('  - UserPromptSubmit hook already registered (no change)')
    return true
  }

  userPromptSubmit.push({
    hooks: [
      {
        type: 'command',
        command: PROMPT_HOOK_COMMAND,
        timeout: 30
      }
    ]
  })

  writeJson(SETTINGS_PATH, data)
  console.log(`  + Added UserPromptSubmit hook to ${SETTINGS_PATH}`)
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

  console.log('Starting mdify as a background service ...')
  const serviceOk = startLaunchdService()

  console.log('\nRegistering MCP server in ~/.claude.json ...')
  const mcpOk = registerMcpServer()

  console.log('\nRegistering PreToolUse hook in ~/.claude/settings.json ...')
  const hookOk = registerHook()

  console.log('\nRegistering UserPromptSubmit hook in ~/.claude/settings.json ...')
  const promptHookOk = registerPromptHook()

  if (serviceOk && mcpOk && hookOk && promptHookOk) {
    console.log('\nDone! Restart Claude Code, then run /mcp to confirm mdify is connected.\n')
    console.log('How it works:')
    console.log('  1. Read hook: use the Read tool on any PDF, DOCX, XLSX, or CSV file.')
    console.log('     mdify intercepts, converts to markdown, and redirects Claude to the')
    console.log('     compact version - transparently, with no extra steps.')
    console.log('  2. Prompt hook: paste a full file path (/path/to/file.xlsx or')
    console.log('     ~/Downloads/file.pdf) directly in your message. mdify detects and')
    console.log('     converts it before Claude processes the prompt - no Read tool needed.')
    console.log('  3. Manual call: invoke mcp__mdify__convert_to_markdown with')
    console.log('     {"file_path": "/path/to/file.xlsx"} to convert on demand.\n')
  } else {
    console.log('\nSetup finished with warnings. Check the messages above.\n')
  }
}

function uninstall() {
  console.log('\nmdify uninstall\n')

  console.log('Stopping background service ...')
  const serviceOk = stopLaunchdService()

  console.log('\nRemoving MCP server from ~/.claude.json ...')
  const mcpOk = unregisterMcpServer()

  console.log('\nRemoving PreToolUse hook from ~/.claude/settings.json ...')
  const hookOk = unregisterHook()

  console.log('\nRemoving UserPromptSubmit hook from ~/.claude/settings.json ...')
  const promptHookOk = unregisterPromptHook()

  if (serviceOk && mcpOk && hookOk && promptHookOk) {
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
  console.log('  (no args)     install: register the MCP server, Read hook, and UserPromptSubmit hook')
  console.log('  --uninstall   remove the MCP server, Read hook, and UserPromptSubmit hook\n')
} else {
  install()
}
