
# Changelog

## v2.7.2 — SSH FS Plus (2026-02-20)

### Improved

- **Multi-edit in `sshfs_edit_file`** — `edits[]` array for multiple find-and-replace operations in one call (max 20, overlap detection, bottom-to-top application)
- **Insert mode in `sshfs_edit_file`** — `insertAfterLine` parameter to insert text at a specific line
- **Auto-retry in `@sshfs`** — on "oldString not found", re-reads the file and feeds fresh content to the model
- **o1/o3 model fallback** — reasoning models fall back to gpt-4o (no tool-calling support)
- **Tool references (`#toolName`)** — `toolMode: Required` when user explicitly references a tool with `#`
- **Better error messages** — all tool errors include actionable recovery hints

## v2.7.1 — SSH FS Plus (2026-02-20)

### New Features

- **QuickDiff change tracking** — gutter indicators, "M" badge in Explorer, Source Control panel with click-to-diff, navigate/accept/reject individual change blocks, auto-scroll to AI-made changes
- **`sshfs_create_file` chat tool** — Copilot can create new files on remote servers with inline diff support and user confirmation
- **Auto-reconnect** — on disconnect, retries 3× with exponential backoff (1s → 2s → 4s) before prompting the user
- **Status bar indicator** — live SSH connection status (disconnected/connecting/connected with names), click to connect
- **Import from `~/.ssh/config`** — new command parses OpenSSH config and lets you pick hosts to import (Host, HostName, User, Port, IdentityFile, ProxyJump)

### Improved

- **Config editor redesign** — collapsible sections, reordered fields, modern styling, required field indicators, password masking
- **readDirectory performance** — eliminated N+1 SFTP stat calls; reads file types from directory listing attributes directly
- **TypeScript strict mode + ES2022 target** — full `strict` enabled, upgraded from ES2019
- **Async deactivate** — properly awaits connection cleanup (2s timeout) before shutdown
- **readFile safety** — 50 MB size limit prevents out-of-memory
- **ssh2 updated to 1.17.0**

### Fixed

- **Connection leak** — `pendingUserCount` never decremented on failure due to variable shadowing
- **WorkspaceFolder configs** — couldn't be edited or deleted (`alterConfigs` always threw)
- **Recursive directory delete** — now recursively deletes contents before removing directory
- **writeFile flags** — properly throws `FileExists`/`FileNotFound` per `FileSystemProvider` contract
- **SFTP close handler crash** — `sftpCommand` crashed on channel close
- **Port validation** — ports 65536–65565 were incorrectly allowed
- **Passwords in debug logs** — `password`, `passphrase`, `privateKey` fields now masked
- **HTTP proxy** — missing error handler caused hang on failure
- **Logger crash** — circular reference handling in `JSON.stringify`
- **Flag listeners** — saw stale values; cache now updated before notifying
- **Temp directory** — uses `mktemp -d` instead of predictable /tmp path
- **Proxy Port description** — showed "Hostname or IP address" instead of "Port number"
- Removed `CorrectHorseBatteryStaple` sample credentials from defaults

## v2.6.3 — SSH FS Plus (2026-02-19)

### Changed

- **Updated extension description** — emphasizes SSH workspace + GitHub Copilot AI support
- **README: MCP Playwright section** — explains how Playwright MCP works out of the box with SSH FS Plus, including a real-world workflow example
- **README: Fixed links** — corrected Language Model Tools URL (was 404), canonical MCP docs URL
- **README: Marketplace link** — added VS Marketplace badge and installation link
- **Changelog cleanup** — removed original SSH FS (v1.x) entries, replaced with link to original repo

## v2.6.2 — SSH FS Plus (2026-02-19)

### Changed

- **README rewrite** — new project motivation section, Copilot tools overview, dependency comparison table

## v2.6.1 — SSH FS Plus (2026-02-19)

### Changed

- **New project logo** — updated extension icon in `resources/Logo.png`

## v2.6.0 — SSH FS Plus (2026-02-19)

### New

- **`@sshfs` Chat Participant** — new Copilot Chat participant for interactive SSH file editing. Type `@sshfs` in the chat to start a conversation that automatically uses SSH tools (`sshfs_read_file`, `sshfs_edit_file`, `sshfs_search_text`, etc.) to work with files on remote servers. Key features:
  - Tool-calling loop with up to 15 rounds for complex multi-step tasks
  - Automatically filters to SSH-specific tools only
  - Runtime detection of proposed `stream.textEdit()` API for inline diff preview (falls back to `workspace.applyEdit()` on stable VS Code)

- **`sshfs_read_file` Copilot tool** — new Language Model Tool for reading file contents directly on the remote server. Replaces slow SFTP-based `read_file` that downloads entire files over the network. Key features:
  - Reads specific line ranges (`startLine`/`endLine`) or entire files
  - Automatically adds line numbers for easy reference
  - Returns up to 500 lines per call with smart truncation
  - Uses `sed`/`head` + `awk` for instant server-side execution
  - No confirmation dialog needed (read-only operation)
  - Shows total line count in header for context
  - Copilot uses this instead of `read_file` for all file reading on SSH workspaces

- **`sshfs_edit_file` Copilot tool** — new Language Model Tool for editing files on remote SSH servers via SFTP. Replaces the built-in `replace_string_in_file` which cannot edit `ssh://` URIs (VS Code blocks them as "outside workspace"). Key features:
  - Exact string find-and-replace (same semantics as `replace_string_in_file`)
  - Reads and writes files via SFTP (binary-safe, preserves encoding)
  - Validates uniqueness — refuses to edit if oldString matches 0 or 2+ locations
  - Shows confirmation dialog with preview of changes before applying
  - 2 MB file size limit to prevent memory issues
  - Reports line number and line count of the edit in the result
  - Copilot uses this instead of `replace_string_in_file` or `sed` commands for all file edits

### Changed

- **`sshfs_search_text` now supports single-file search** — when `path` points to a file (has extension), uses non-recursive grep without `--exclude-dir` flags. No need to use `sshfs_run_command` with manual grep for single-file searches.
- **Updated tool descriptions** — all tools now cross-reference `sshfs_read_file` and `sshfs_edit_file` to prevent Copilot from falling back to slow/broken built-in alternatives

### Fixed

- **`sshfs_read_file` awk escape sequences** — `\t` and `\n` in template literals were interpreted by JavaScript as literal tab/newline characters, breaking the awk command. Fixed to `\\t`/`\\n`.

### Dependencies

- **React** 18 → 19
- **Redux** 4 → 5 (`legacy_createStore`, `UnknownAction`-compatible action types)
- **react-redux** 7 → 9 (removed `@types/react-redux` — types now built-in)
- **react-refresh** 0.10 → 0.16
- **@pmmmwh/react-refresh-webpack-plugin** 0.5.0-rc.3 → 0.6
- **ESLint** 8 → 9 with flat config (`eslint.config.mjs` replacing `.eslintrc.json`)
- **typescript-eslint** — unified package `^8.0.0` replacing separate `@typescript-eslint/parser` + `@typescript-eslint/eslint-plugin`
- **Prettier** 2 → 3
- **@vscode/vsce** 2 → 3
- **css-loader** 4 → 7, **style-loader** 1 → 4, **mini-css-extract-plugin** 0.11 → 2, **css-minimizer-webpack-plugin** 3 → 7
- **dotenv** 8 → 16
- **@types/webpack** 4 → 5, **@types/semver** 7.3 → 7.7, **@types/react** 18 → 19, **@types/react-dom** 18 → 19
- Removed `pnp-webpack-plugin` (unused with webpack 5) and `url-loader` (replaced by webpack 5 native `type: 'asset'`)

## v2.5.0 — SSH FS Plus (2026-02-19)

### New

- **`sshfs_directory_tree` Copilot tool** — new Language Model Tool that retrieves the full hierarchical directory tree of a remote project in a single server-side command. Uses `tree` (with `find` fallback). Key features:
  - Configurable depth (1–8, default 3)
  - Excludes common junk directories (`.git`, `node_modules`, `vendor`, etc.)
  - Returns formatted indented tree structure
  - Replaces hundreds of slow recursive SFTP `readdir` calls with one fast command
  - Copilot uses this automatically to understand project structure at the start of conversations

### Fixed

- **`sshfs_find_files` now finds both files and directories** — previously used `-type f` which excluded folders entirely (e.g. searching for "ThemeOffice" folder returned nothing). Now finds files AND folders with a single tool.

### Changed

- **Simplified tool roles to prevent Copilot confusion** — each tool now has exactly one clear purpose:
  - `sshfs_find_files` — find files/folders by name (the ONE tool for all name-based searches)
  - `sshfs_list_directory` — list contents of a specific directory (like `ls`, no search mode)
  - `sshfs_directory_tree` — project structure overview (like `tree`)
  - `sshfs_search_text` — search text inside files (like `grep`)
  - `sshfs_run_command` — general shell commands
- **Removed search mode from `sshfs_list_directory`** — directory name search is now handled by `sshfs_find_files`, eliminating tool overlap that caused Copilot to pick the wrong tool

## v2.4.3 — SSH FS Plus (2026-02-19)

### Fixed

- **Copilot ignoring SSH tools** — drastically strengthened `modelDescription` for all 4 Language Model Tools (`sshfs_run_command`, `sshfs_find_files`, `sshfs_list_directory`, `sshfs_search_text`). Each description now clearly states that built-in tools (`file_search`, `list_dir`, `grep_search`) WILL FAIL on SSH workspaces due to SFTP timeouts, and explicitly directs Copilot to use the SSH-specific tool instead. Previously, Copilot often chose built-in tools first, which timed out, instead of using the faster server-side tools.

## v2.4.2 — SSH FS Plus (2026-02-18)

### New

- **`sshfs_list_directory` Copilot tool** — new dedicated Language Model Tool for directory operations on remote SSH servers. Supports two modes:
  - **List mode**: lists contents of a directory (files and subdirectories) with type indicators (`/` suffix for directories)
  - **Search mode**: finds directories by name or glob pattern recursively (e.g. `templates`, `mod_*`, `*admin*`)
  - Automatically excludes common directories (`.git`, `node_modules`, `vendor`, etc.)
  - Copilot agent uses this instead of the slow SFTP-based `list_dir` tool

### Fixed

- **`sshfs_find_files` no longer blocks directory searches** — previously used `-type f` exclusively, making it impossible to discover directories. Directory discovery is now handled by the new `sshfs_list_directory` tool.

## v2.4.1 — SSH FS Plus (2026-02-18)

### Fixed

- **`sshfs_find_files` path prefix handling** — patterns like `administrator/modules/mod_jcefilebrowser/*` now correctly narrow the search to the specified subdirectory instead of searching the entire workspace root. Previously the path prefix was extracted but never applied to the search path, causing `find -iname '*'` to match every file.
- Directory listing patterns (trailing `/*`) now use `-maxdepth 1` for fast direct listing instead of recursive search.

## v2.4.0 — SSH FS Plus (2026-02-18)

### New — Copilot Language Model Tools

File search and text search are now provided as **dedicated Copilot tools** using the stable Language Model Tools API (`vscode.lm.registerTool`). This works for all users without any workarounds.

- **`sshfs_find_files`** — fast file search via `find` on the remote server. Copilot agent uses this instead of the slow SFTP-based `file_search` which walks every directory over the network.
- **`sshfs_search_text`** — fast text/grep search via `grep` on the remote server. Copilot agent uses this instead of downloading and scanning every file via SFTP.
- Both tools support: glob patterns, subdirectory filtering, regex, case sensitivity, file type filtering, and automatic exclusion of common directories (`.git`, `node_modules`, `vendor`, etc.)

### Removed

- **Removed proposed API dependency** — `FileSearchProvider` and `TextSearchProvider` (proposed VS Code APIs) have been removed. These required `enabledApiProposals` which only works in extension development mode or with manual `argv.json` configuration — meaning they never worked for normal users.
- Removed `enabledApiProposals` from `package.json`

### Kept

- **`WorkspaceSymbolProvider`** (stable API) — Ctrl+T symbol search still runs `grep` on the remote server
- **`sshfs_run_command`** — general-purpose SSH command tool for Copilot

## v2.3.3 — SSH FS Plus (2026-02-18)

### Fixed

- **FileSearchProvider — glob prefix stripping** — patterns like `**/mobile-optimized.css` sent by Copilot/VS Code now correctly have `**/` and `*/` prefixes removed before being passed to `find -iname`, which does not understand recursive globs
- **FileSearchProvider — path-containing patterns** — patterns like `css/mobile-optimized.css` are now split into a subdirectory prefix and filename; if the subdirectory search yields no results, the full base path is retried
- **Exclude patterns** — `vendor/bundle` replaced with `vendor` in both FileSearchProvider and TextSearchProvider default excludes, since `find -name` and `grep --exclude-dir` only match directory basenames, not paths with slashes
- **Wildcard normalization** — remaining `**` in patterns after prefix stripping is converted to `*` for `find` compatibility
- Increased FileSearch timeout from 10 s to 15 s
- Added `Logging.info` diagnostic messages showing raw query, normalized pattern, and executed `find` command for easier troubleshooting via the SSH FS Plus output channel

## v2.2.0 — SSH FS Plus (2026-02-17)

### Remote Search Providers (Copilot / AI Agent Performance)

- **`FileSearchProvider`** — file search (Ctrl+P) now runs `find` directly on the remote server instead of recursively walking directories via SFTP. Makes file discovery 10–100× faster for Copilot agent
- **`TextSearchProvider`** — text search (Ctrl+Shift+F) now runs `grep` on the remote server instead of downloading and scanning every file. Makes grep operations 10–100× faster for Copilot agent
- Both providers are registered via proposed VS Code APIs with graceful runtime fallback
- Smart default excludes (`.git`, `node_modules`, `.yarn`, `__pycache__`, `.cache`)
- Fuzzy file name matching, case-insensitive search, regex support

## v2.1.0 — SSH FS Plus (2026-02-17)

### Improvements

- **`deactivate()` handler** — extension now properly closes all SSH connections on shutdown/reload for clean resource cleanup
- **Engine bump to `^1.100.0`** — enables access to modern VS Code APIs (finalized Quick Input Button Location APIs, etc.)
- **Webpack modernization** — replaced deprecated `fs.exists()` with `fs.existsSync` / `fs.promises` in build config

## v2.0.0 — SSH FS Plus (2026-02-17)

> First release of **SSH FS Plus**, an enhanced fork of [SSH FS](https://github.com/SchoofsKelvin/vscode-sshfs) by [Kelvin Schoofs](https://github.com/SchoofsKelvin).

### Highlights

- **React 18 upgrade** — webview UI migrated from React 17 to React 18 (`createRoot` API)
- **ESLint migration** — replaced deprecated TSLint with ESLint + `@typescript-eslint`
- **`extensionKind: ["ui", "workspace"]`** — extension runs in the local UI host, keeping MCP / Copilot requests local when connected to a remote SSH workspace
- **Auto-reconnect** — SSH connections automatically re-establish after unexpected disconnects
- **Dynamic extension ID** — removed hard-coded `'Kelvin.vscode-sshfs'` publisher references; works under any publisher name

### Bug Fixes

- Fixed `replaceVariablesRecursive` being called as `this.replaceVariablesRecursive()` (it is a free function, not a class method), added `Promise.all` for async array handling
- Fixed `quickPickItemTooltip` proposed-API crash when opening SSH FS settings — tooltip is now stripped from QuickPick items
- Optimized `.vscodeignore` to reduce VSIX package size

### Development

- Updated ssh2 from patched ^1.11.0 to ^1.16.0
- Updated TypeScript from ~5.0.2 to ~5.7.3
- Updated Yarn from 3.5.0 to 4.6.0
- Updated VS Code engine requirement to ^1.90.0
- Updated `@types/vscode` to ^1.90.0


---

For changelog of the original SSH FS project (v1.x), see the [original repository](https://github.com/SchoofsKelvin/vscode-sshfs/blob/master/CHANGELOG.md).
