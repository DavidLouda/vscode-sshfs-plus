
# SSH FS Plus

![Logo](./resources/Logo.png)

[![GitHub release](https://img.shields.io/github/v/release/DavidLouda/vscode-sshfs-plus?include_prereleases&label=GitHub%20version)](https://github.com/DavidLouda/vscode-sshfs-plus/releases)
[![VS Marketplace](https://img.shields.io/visual-studio-marketplace/v/DavidLouda.vscode-sshfs-plus?label=VS%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=DavidLouda.vscode-sshfs-plus)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPL%20v3-blue.svg)](LICENSE.txt)

> **Enhanced & maintained fork of [SSH FS](https://github.com/SchoofsKelvin/vscode-sshfs) by [Kelvin Schoofs](https://github.com/SchoofsKelvin)**

Mount remote folders as local workspace folders, launch integrated remote terminals and run `ssh-shell` tasks — all over SSH.

## Why does this exist?

Because I needed it. Seriously. The original SSH FS stopped being maintained, and every other solution I tried had at least one deal-breaker — whether it was requiring a server-side daemon, not working on restricted servers, or just missing features I needed. So I did what any reasonable developer would do — I forked it and started fixing things myself.

This is primarily a personal project. I use it daily, I fix what annoys me, and I add features when I need them. If it's useful to you too — great! But fair warning: the roadmap is basically "whatever I need next."

## What's different from the original SSH FS?

### 🤖 Copilot Integration *(v2.4+)*

The biggest addition. Seven custom [Language Model Tools](https://code.visualstudio.com/api/extension-guides/ai/tools) that make GitHub Copilot actually useful on remote SSH workspaces:

| Tool | What it does |
|---|---|
| `sshfs_run_command` | Run shell commands on the remote server |
| `sshfs_find_files` | Find files and directories by name/glob |
| `sshfs_list_directory` | List directory contents |
| `sshfs_directory_tree` | Get full project tree structure |
| `sshfs_search_text` | Grep through files (with single-file support) |
| `sshfs_read_file` | Read file contents with line ranges (server-side, no SFTP download) |
| `sshfs_edit_file` | Find-and-replace editing via SFTP with confirmation dialog |

VS Code's built-in Copilot tools are designed for local/Remote SSH workspaces and don't support custom `ssh://` filesystem URIs. These tools bridge that gap — they execute directly on the remote server via SSH, so Copilot works just as well on SSH FS mounts as it does locally.

There's also an **`@sshfs` Chat Participant** *(v2.6+)* — type `@sshfs` in Copilot Chat and it automatically routes all operations through the SSH-specific tools.

### 🎭 MCP Playwright — works out of the box

[Playwright](https://playwright.dev/) is a browser automation framework by Microsoft — it can programmatically open web pages, click buttons, fill forms, take screenshots and run end-to-end tests across Chromium, Firefox and WebKit.

VS Code supports Playwright as an [MCP (Model Context Protocol)](https://code.visualstudio.com/docs/copilot/customization/mcp-servers) server, which means GitHub Copilot in agent mode can control a real browser directly from chat — navigate to URLs, interact with page elements, capture screenshots, and more.

Because SSH FS Plus runs in the **local VS Code UI host** (`extensionKind: ["ui", "workspace"]`), all MCP traffic stays on your local machine. Playwright launches a local browser, Copilot talks to it via MCP, and your SSH remote workspace works alongside it without any conflicts. No special configuration needed — just open the Extensions view, search `@mcp playwright`, and install an MCP Playwright server directly from the [built-in MCP gallery](https://code.visualstudio.com/docs/copilot/customization/mcp-servers#_add-an-mcp-server-from-the-mcp-server-gallery).

**My typical workflow:** I edit websites on remote servers over SSH, and when I need visual tweaks, I just tell Copilot to open the site's URL in Playwright. It navigates to the page, takes a screenshot, spots visual issues, edits the code on the remote server, and reloads — all in one conversation. Code editing and visual debugging in a single loop, no context switching.

This makes SSH FS Plus a great setup for workflows like:
- Editing code on a remote server while Copilot visually debugs the result in a local browser
- Asking Copilot to verify API responses by navigating to endpoints
- Automated UI testing driven by natural language in Copilot Chat

### 🔧 Modernization & Fixes

| Area | Original SSH FS | SSH FS Plus |
|---|---|---|
| **React** | 17 | 19 |
| **Redux** | 4 | 5 |
| **ESLint** | TSLint (deprecated) | ESLint 9 (flat config) |
| **TypeScript** | ~4.x | ~5.7 |
| **Yarn** | 1.x | 4.6 (PnP) |
| **VS Code engine** | ^1.49.0 | ^1.100.0 |
| **ssh2** | 1.4 | 1.16 |
| **Webpack** | 4 | 5 |
| **Prettier** | 2 | 3 |

### 🐛 Bug Fixes

- **Auto-reconnect** — connections automatically re-establish after unexpected disconnects
- **`replaceVariablesRecursive`** — fixed incorrect variable substitution
- **`quickPickItemTooltip`** — removed proposed API crash
- **`extensionKind: ["ui", "workspace"]`** — runs in the local UI host, keeping Copilot/MCP traffic local
- **Dynamic extension ID** — no more hard-coded publisher name
- **FileSearchProvider & TextSearchProvider** *(v2.2+)* — remote file/text search via `find`/`grep` for VS Code's search sidebar

## Installation

Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=DavidLouda.vscode-sshfs-plus), or:

1. Download the latest `.vsix` from [Releases](https://github.com/DavidLouda/vscode-sshfs-plus/releases)
2. In VS Code: **Extensions** → **⋯** → **Install from VSIX…**
3. Reload VS Code

## Features

### Config editor

The built-in config editor makes it easy to create and edit configurations:
![Config editor](./media/config-editor.png)

Configurations are stored in your User Settings (`settings.json`), workspace settings, or external JSON files configured with `sshfs.configpaths`.

### Terminals

Open remote terminals with a single click or from the command palette:
![Terminals](./media/terminals.png)

Uses `$SHELL` by default. Existing connections are reused — no need to reauthenticate.

### Remote shell tasks

A `ssh-shell` task type for running shell commands remotely with full PTY support:
![Remote shell tasks](./media/shell-tasks.png)

### Remote workspace folders

Mount remote directories as regular workspace folders:
![Remote workspace folder](./media/workspace-folder.png)

Works with extensions using the `vscode.workspace.fs` API. Right-click any remote directory to open a terminal there.

### Proxy support

SSH hopping, HTTP and SOCKS 4/5 proxies are supported:
![Proxy settings](./media/proxy-settings.png)

SSH Hop works similarly to OpenSSH's `ProxyJump`:
![Hop config field](./media/hop-config.png)

### SFTP Command / Sudo

Custom `sftp` subsystem commands and sudo support for operating on remote files as root:
![SFTP and Terminal Command config fields](./media/sftp-config.png)

## Links

- [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=DavidLouda.vscode-sshfs-plus)
- [GitHub (this fork)](https://github.com/DavidLouda/vscode-sshfs-plus) ([Issues](https://github.com/DavidLouda/vscode-sshfs-plus/issues) | [Releases](https://github.com/DavidLouda/vscode-sshfs-plus/releases))
- [Original SSH FS by Kelvin Schoofs](https://github.com/SchoofsKelvin/vscode-sshfs) ([VS Marketplace](https://marketplace.visualstudio.com/items?itemName=Kelvin.vscode-sshfs) | [Open VSX](https://open-vsx.org/extension/Kelvin/vscode-sshfs))

## Credits

This project is a fork of **[SSH FS](https://github.com/SchoofsKelvin/vscode-sshfs)** created by **[Kelvin Schoofs](https://github.com/SchoofsKelvin)**, licensed under [GPL-3.0](LICENSE.txt).  
All original code and design credit belongs to Kelvin Schoofs. This fork adds modernization, bug fixes and quality-of-life improvements on top of the original work.
