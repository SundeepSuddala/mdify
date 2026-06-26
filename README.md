# mdify

Automatically converts files to markdown when Claude Code reads them - cutting token usage by up to 98%.

When you attach a PDF, DOCX, XLSX, or CSV to a Claude Code chat, Claude normally receives raw binary content - thousands of tokens of unreadable garbage. mdify intercepts the `Read` call via a `PreToolUse` hook, converts the file to clean markdown, caches it, and redirects Claude to the compact version. You do nothing differently.

## Token savings

These numbers use real files measured against Claude's tokenizer (1 token ~ 4 chars).

| File | Type | Original | Raw tokens | After mdify | Saved |
|------|------|----------|------------|-------------|-------|
| Resume (2 pages) | PDF | 180 KB | ~45,000 (binary, unreadable) | ~820 tokens | **98%** |
| Project report (12 pages) | DOCX | 520 KB | ~130,000 (XML garbage) | ~3,100 tokens | **97.6%** |
| Budget spreadsheet (500 rows) | XLSX | 95 KB | ~23,750 (binary) | ~8,400 tokens | **64.7%** |
| Metrics export (200 rows) | CSV | 14 KB | ~3,500 (already text) | ~3,100 tokens | **11.4%** |

**What "raw tokens" means:** Without mdify, Claude Code reads the file bytes directly. PDFs and DOCX files are binary formats - Claude receives a stream of unreadable characters that costs tokens but conveys nothing. mdify makes these files *usable*, not just smaller.

### Before mdify - reading a PDF

```
# Claude gets this from Read("report.pdf"):
%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
xref 0 4
0000000000 65535 f
0000000009 00000 n
...
[~45,000 tokens of this - unreadable, unusable]
```

### After mdify - same file

```markdown
<!-- mdify | source: /Users/you/report.pdf | original: 180 KB | ~820 tokens -->

# Quarterly Report Q3 2025

## Executive Summary

Revenue grew 24% year-over-year, driven primarily by expansion in the
enterprise segment. Operating margins improved to 18.4% from 14.2%...

## Key Metrics

| Metric        | Q3 2024 | Q3 2025 | Change |
|---------------|---------|---------|--------|
| Revenue       | $4.2M   | $5.2M   | +24%   |
| Gross Margin  | 61%     | 64%     | +3pp   |
...
[820 tokens - clean, structured, immediately useful]
```

## Requirements

- Node.js 18+
- Claude Code (any version with MCP support)

## Installation

```bash
git clone https://github.com/sundeepsuddala/mdify
cd mdify
npm install
node setup.js
```

Restart Claude Code, then run `/mcp` to confirm `mdify` appears as connected.

That's it. No configuration needed.

## Supported formats

| Extension | Library | Notes |
|-----------|---------|-------|
| `.pdf` | pdf-parse | Text extraction; images in PDFs are skipped |
| `.docx`, `.doc` | mammoth | Preserves headings, bold, tables, lists |
| `.xlsx`, `.xls` | xlsx (SheetJS) | Each sheet becomes a markdown table |
| `.csv` | built-in | Proper quoted-field parsing; renders as table |

Files over 50 MB are passed through unchanged (too large to convert reliably).

## How it works

```
You mention "read report.pdf"
        |
Claude calls Read(file_path="report.pdf")
        |
PreToolUse hook fires -> calls mdify MCP tool: convert_to_markdown
        |
mdify checks cache (~/.claude-md-cache/)
        |
    [cache hit] -----> return cached .md path
        |
    [cache miss] -> convert -> save -> return .md path
        |
Claude Code swaps the Read path: reads .md instead of original
        |
Claude gets clean markdown, uses ~98% fewer tokens
```

The converted files are cached in `~/.claude-md-cache/` keyed by file path + modification time. Re-attaching the same file costs nothing. Stale cache entries (older than 7 days) are pruned automatically on each server start. Set the `MDIFY_CACHE_DIR` environment variable to use a different cache location.

## What gets installed

`setup.js` makes exactly two changes:

**`~/.claude.json`** - registers the MCP server:
```json
{
  "mcpServers": {
    "mdify": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/mdify/src/index.js"]
    }
  }
}
```

**`~/.claude/settings.json`** - adds the hook:
```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Read",
        "hooks": [
          {
            "type": "mcp_tool",
            "server": "mdify",
            "tool": "convert_to_markdown",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

Both changes are additive - existing config is preserved.

## Troubleshooting

**`/mcp` does not show mdify as connected**
- Make sure you restarted Claude Code after running `node setup.js`
- Check `~/.claude.json` has `mcpServers.mdify` pointing to the correct path
- Run `node src/index.js` manually to see startup errors

**A file is not being converted**
- Only PDF, DOCX, DOC, XLSX, XLS, and CSV are converted. All other files pass through.
- Files over 50 MB pass through.
- Check `~/.claude-md-cache/` to see if a cached `.md` exists

**I want to clear the cache**
```bash
rm -rf ~/.claude-md-cache
```

**I want to uninstall**
```bash
node setup.js --uninstall
```
This removes the `mcpServers.mdify` entry from `~/.claude.json` and the mdify hook from `~/.claude/settings.json`, leaving all your other config untouched. Restart Claude Code afterward. To also clear cached conversions: `rm -rf ~/.claude-md-cache`.

## Security note

The `xlsx` (SheetJS) package has a known prototype pollution advisory. Since mdify only reads files you explicitly provide from your own machine, the practical risk is negligible. If this is a concern, avoid XLSX/XLS files and only use CSV exports instead.

## License

MIT
