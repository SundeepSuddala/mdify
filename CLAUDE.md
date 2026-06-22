# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

mdify is an MCP (stdio) server that intercepts Claude Code's `Read` calls via a `PreToolUse` hook and transparently converts PDF/DOCX/XLSX/CSV files to compact markdown before they enter the context window. The user does nothing differently — the hook fires, mdify returns a redirect to a cached `.md` file, and Claude reads that instead.

## Commands

```bash
npm install              # install deps (required before setup)
node setup.js            # one-time: register MCP server + hook in ~/.claude config
node setup.js --uninstall # remove the MCP server + hook (preserves other config)
npm start                # run the server manually — useful to see startup errors on stderr
npm test                 # run the test suite (node --test, zero deps)
node --test test/cache.test.mjs   # run a single test file
rm -rf ~/.claude-md-cache         # clear the conversion cache
```

Tests use Node's built-in runner (`node:test` + `node:assert`), no framework. Cache tests set `MDIFY_CACHE_DIR` to a temp dir so they never touch the real `~/.claude-md-cache`. The server also logs to stderr with a `[mdify]` prefix when run manually.

## Architecture

Three source files under `src/`, plus a standalone installer:

- **`src/index.js`** — the MCP server. Exposes a single tool, `convert_to_markdown`, which receives the hook's `tool_input` payload. The control flow is a series of pass-through gates: missing path → not on disk → not a convertible extension → no cache key all return `passThrough()` (hook output `permissionDecision: 'allow'` with no change). On a cache hit or successful conversion it returns `redirect(mdPath)`, which sets `updatedInput.file_path` so Claude reads the markdown instead. **Conversion errors also pass through** — mdify never blocks a Read, it only ever swaps the path or leaves it alone.

- **`src/converter.js`** — pure conversion logic, one function per format (`convertPdf`/`convertDocx`/`convertXlsx`/`convertCsv`), dispatched by extension in `convert()`. Heavy deps (`pdf-parse`, `mammoth`, `xlsx`) are dynamically `import()`ed inside their converter so server startup stays cheap. Every output gets a `<!-- mdify | source: ... | ~N tokens -->` header and is truncated at `MAX_OUTPUT_CHARS` (200k). Files over `MAX_INPUT_BYTES` (50 MB) are rejected by `isConvertible()`. CSV uses a hand-rolled quoted-field parser (`parseCsvRows`), not a library.

- **`src/cache.js`** — content cache at `~/.claude-md-cache/` (override with `MDIFY_CACHE_DIR`). Cache key is `sha256(filePath:mtimeMs)`, so editing a file naturally invalidates its entry. `writeCache` writes to a unique temp file then atomically `renameSync`s into place — a crash or concurrent reader never sees a partial entry. `pruneStaleCache()` (called once on server start from index.js) deletes `.md` files older than 7 days.

- **`setup.js`** — idempotent installer. Makes exactly two additive edits: registers `mcpServers.mdify` in `~/.claude.json` and appends a `PreToolUse` matcher for `Read` in `~/.claude/settings.json`. Re-running detects existing entries and makes no change.

## Conventions

- ES modules (`"type": "module"`), Node 18+, no transpilation. Use `import`, top-level `await` (see end of `index.js`), and `.js` extensions in relative imports.
- The hook contract is the integration point: the server's tool return value **must** be the JSON-stringified `hookSpecificOutput` shape Claude Code expects. Changing `passThrough()`/`redirect()` shape breaks the interception silently.
- Adding a new format means: extend `CONVERTIBLE_EXTENSIONS` in converter.js, add a `convertX()` function, and add a `case` in `convert()`. No other file needs to change.
