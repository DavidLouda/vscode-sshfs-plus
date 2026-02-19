import type { Client, ClientChannel } from 'ssh2';
import * as vscode from 'vscode';
import type { ConnectionManager } from './connection';
import { Logging } from './logging';
import { toPromise } from './utils';

/**
 * Input schema for the sshfs_run_command language model tool.
 */
interface SSHRunCommandInput {
    command: string;
    connectionName?: string;
}

/**
 * Input schema for the sshfs_find_files language model tool.
 */
interface SSHFindFilesInput {
    pattern: string;
    path?: string;
    connectionName?: string;
}

/**
 * Input schema for the sshfs_list_directory language model tool.
 */
interface SSHListDirectoryInput {
    path?: string;
    connectionName?: string;
}

/**
 * Input schema for the sshfs_directory_tree language model tool.
 */
interface SSHDirectoryTreeInput {
    path?: string;
    depth?: number;
    connectionName?: string;
}

/**
 * Input schema for the sshfs_search_text language model tool.
 */
interface SSHSearchTextInput {
    query: string;
    includePattern?: string;
    path?: string;
    isRegex?: boolean;
    caseSensitive?: boolean;
    connectionName?: string;
}

/**
 * Executes a command on the SSH server and returns stdout.
 * Returns null if the command fails, produces no output, or times out.
 */
async function execCommand(client: Client, command: string, token?: vscode.CancellationToken, timeoutMs = 15_000): Promise<string | null> {
    let channel: ClientChannel;
    try {
        channel = await toPromise<ClientChannel>(cb => client.exec(command, cb));
    } catch {
        return null;
    }
    return new Promise<string | null>((resolve) => {
        const chunks: string[] = [];
        let resolved = false;

        const finish = (result: string | null) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            cancelDispose?.dispose();
            resolve(result);
        };

        const timer = setTimeout(() => {
            channel.close();
            const partial = chunks.join('');
            finish(partial || null);
        }, timeoutMs);

        const cancelDispose = token?.onCancellationRequested(() => {
            channel.close();
            finish(null);
        });

        channel.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf-8')));
        channel.on('close', () => {
            const output = chunks.join('');
            finish(output || null);
        });
        channel.stderr!.on('data', () => { /* ignore stderr */ });
    });
}

/** Escapes a string for use in a shell command (wraps in single quotes). */
function shellEscape(str: string): string {
    return "'" + str.replace(/'/g, "'\\''") + "'";
}

/**
 * Language Model Tool — allows Copilot agent mode to execute shell commands
 * on a connected remote SSH server. This dramatically accelerates agent workflows
 * by providing direct server access instead of relying on file-by-file SFTP operations.
 *
 * Copilot can use this tool to: inspect files, list directories, run tests,
 * check configurations, examine logs, run git commands, etc.
 */
class SSHRunCommandTool implements vscode.LanguageModelTool<SSHRunCommandInput> {
    constructor(private readonly connectionManager: ConnectionManager) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<SSHRunCommandInput>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { command, connectionName } = options.input;

        // Find the target connection
        const conn = connectionName
            ? this.connectionManager.getActiveConnection(connectionName)
            : this.connectionManager.getActiveConnections()[0];

        if (!conn) {
            const available = this.connectionManager.getActiveConnections().map(c => c.config.name);
            throw new Error(
                connectionName
                    ? `No active SSH connection "${connectionName}". Available: ${available.join(', ') || 'none'}. Try reconnecting.`
                    : `No active SSH connections. Connect via SSH FS Plus first. Available: ${available.join(', ') || 'none'}`
            );
        }

        Logging.info`ChatTool sshfs_run_command: executing "${command}" on ${conn.config.name}`;

        let channel: ClientChannel;
        try {
            channel = await toPromise<ClientChannel>(cb => conn.client.exec(command, cb));
        } catch (e) {
            throw new Error(
                `Failed to execute command on SSH server "${conn.config.name}": ${e instanceof Error ? e.message : String(e)}. ` +
                `The connection may have been lost. Try reconnecting with the SSH FS Plus extension.`
            );
        }

        // Timeout to prevent hanging on commands that never exit (tail -f, watch, top, etc.)
        const COMMAND_TIMEOUT_MS = 30_000;

        const output = await new Promise<string>((resolve) => {
            const stdoutChunks: string[] = [];
            const stderrChunks: string[] = [];
            let resolved = false;

            const finish = (result: string) => {
                if (resolved) return;
                resolved = true;
                clearTimeout(timer);
                cancelDispose.dispose();
                resolve(result);
            };

            const timer = setTimeout(() => {
                channel.close();
                const partial = stdoutChunks.join('') + (stderrChunks.length ? '\n--- stderr ---\n' + stderrChunks.join('') : '');
                finish(partial ? partial + '\n... [timed out after 30s]' : '(command timed out after 30s with no output)');
            }, COMMAND_TIMEOUT_MS);

            const cancelDispose = token.onCancellationRequested(() => {
                channel.close();
                finish('[Command cancelled]');
            });

            channel.on('data', (chunk: Buffer) => stdoutChunks.push(chunk.toString('utf-8')));
            channel.stderr!.on('data', (chunk: Buffer) => stderrChunks.push(chunk.toString('utf-8')));
            channel.on('close', (code: number) => {
                const stdout = stdoutChunks.join('');
                const stderr = stderrChunks.join('');
                let result = '';
                if (stdout) result += stdout;
                if (stderr) result += (result ? '\n--- stderr ---\n' : '') + stderr;
                if (!result) result = `(no output, exit code: ${code})`;

                // Truncate very large outputs to avoid overwhelming the LLM context
                const MAX_OUTPUT = 50_000;
                if (result.length > MAX_OUTPUT) {
                    result = result.substring(0, MAX_OUTPUT) + `\n... [truncated at ${MAX_OUTPUT} chars]`;
                }

                finish(result);
            });
        });

        Logging.debug`ChatTool sshfs_run_command: ${output.length} chars output`;

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(output)
        ]);
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<SSHRunCommandInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const connLabel = options.input.connectionName || 'default';
        const cmd = options.input.command;

        // Warn about potentially dangerous commands
        const dangerousPatterns = /\brm\s+-[^\s]*r|\brm\s+-[^\s]*f|\bmkfs\b|\bdd\b.*of=|\b(shutdown|reboot|halt|poweroff)\b|\bchmod\s+-R\s+000|\b:\(\)\{|\bfork\s*bomb/i;
        let warning = '';
        if (dangerousPatterns.test(cmd)) {
            warning = '\n\n⚠️ **Warning: This command may be destructive or dangerous!**';
        }

        return {
            invocationMessage: `Running on SSH (${connLabel}): \`${cmd}\``,
            confirmationMessages: {
                title: 'SSH Remote Command',
                message: new vscode.MarkdownString(
                    `Execute on **${connLabel}**?\n\n\`\`\`bash\n${cmd}\n\`\`\`${warning}`
                ),
            },
        };
    }
}

/**
 * Language Model Tool — fast file search on remote SSH server using `find`.
 * Copilot uses this instead of the slow SFTP-based workspace.findFiles().
 */
class SSHFindFilesTool implements vscode.LanguageModelTool<SSHFindFilesInput> {
    constructor(private readonly connectionManager: ConnectionManager) {}

    private getConnection(connectionName?: string) {
        const conn = connectionName
            ? this.connectionManager.getActiveConnection(connectionName)
            : this.connectionManager.getActiveConnections()[0];
        if (!conn) {
            const available = this.connectionManager.getActiveConnections().map(c => c.config.name);
            throw new Error(
                connectionName
                    ? `No active SSH connection "${connectionName}". Available: ${available.join(', ') || 'none'}.`
                    : `No active SSH connections. Available: ${available.join(', ') || 'none'}`
            );
        }
        return conn;
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<SSHFindFilesInput>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { pattern, path, connectionName } = options.input;
        const conn = this.getConnection(connectionName);

        // Determine search root from workspace folder config or input path
        const root = conn.config.root || '/';
        let searchPath = path
            ? (path.startsWith('/') ? path : root.replace(/\/$/, '') + '/' + path)
            : root;

        // Normalize pattern: strip glob prefixes, extract filename
        let normalized = pattern.trim()
            .replace(/^(\*\*\/)+/, '')
            .replace(/^\*\//, '');
        // Extract path prefix and filename from path-containing patterns
        // e.g. "administrator/modules/mod_jcefilebrowser/*" → prefix="administrator/modules/mod_jcefilebrowser", name="*"
        const lastSlash = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
        let pathPrefix = '';
        if (lastSlash >= 0) {
            pathPrefix = normalized.substring(0, lastSlash);
            normalized = normalized.substring(lastSlash + 1);
        }

        // Apply path prefix to narrow search scope
        if (pathPrefix) {
            searchPath = searchPath.replace(/\/$/, '') + '/' + pathPrefix;
        }

        if (!normalized) {
            // Pattern ended with / — list all files in the directory
            normalized = '*';
        }

        // Convert ** to * for find compatibility
        normalized = normalized.replace(/\*\*/g, '*');

        // Default excludes
        const defaultExcludes = ['.git', 'node_modules', '.yarn', '__pycache__', '.cache', '.venv', 'vendor'];
        const excludeParts = defaultExcludes.map(e => `-name ${shellEscape(e)} -prune`).join(' -o ');

        // Build find pattern: exact match first if it looks like a filename, then glob
        const hasExtension = /\.[a-zA-Z0-9]{1,10}$/.test(normalized);
        const hasWildcard = /[*?\[\]]/.test(normalized);
        const MAX_RESULTS = 200;

        let findPatterns: string[];
        if (hasWildcard) {
            findPatterns = [normalized];
        } else if (hasExtension) {
            findPatterns = [normalized, `*${normalized}*`];
        } else {
            findPatterns = [`*${normalized}*`];
        }

        Logging.info`ChatTool sshfs_find_files: pattern="${pattern}" normalized="${normalized}" pathPrefix="${pathPrefix}" searchPath="${searchPath}"`;

        // If pattern is just "*" (listing a directory), use -maxdepth 1 for direct listing
        const isDirectoryListing = normalized === '*' && pathPrefix;

        for (const fp of findPatterns) {
            if (token.isCancellationRequested) break;

            const depthLimit = isDirectoryListing ? '-maxdepth 1 ' : '';
            const cmd = `find ${shellEscape(searchPath)} ${depthLimit}\\( ${excludeParts} \\) -o -iname ${shellEscape(fp)} -print 2>/dev/null | head -n ${MAX_RESULTS}`;
            const output = await execCommand(conn.client, cmd, token, 15_000);

            if (output && output.trim()) {
                const lines = output.trim().split('\n').filter(l => l.trim());
                Logging.info`ChatTool sshfs_find_files: ${lines.length} results for "${fp}"`;

                // Format output: show paths relative to root if possible
                const formatted = lines.map(l => {
                    const trimmed = l.trim();
                    if (trimmed.startsWith(root)) {
                        return trimmed.substring(root.length).replace(/^\//, '');
                    }
                    return trimmed;
                }).join('\n');

                const summary = lines.length >= MAX_RESULTS
                    ? `Found ${MAX_RESULTS}+ results matching "${pattern}" (results truncated):\n`
                    : `Found ${lines.length} result(s) matching "${pattern}":\n`;

                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(summary + formatted)
                ]);
            }
        }

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`No files or directories found matching "${pattern}" in ${searchPath}`)
        ]);
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<SSHFindFilesInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        return {
            invocationMessage: `Searching for files matching "${options.input.pattern}" on SSH server...`,
        };
    }
}

/**
 * Language Model Tool — lists the contents of a single directory on a remote SSH server.
 * Like running `ls` — shows files and subdirectories with type indicators.
 */
class SSHListDirectoryTool implements vscode.LanguageModelTool<SSHListDirectoryInput> {
    constructor(private readonly connectionManager: ConnectionManager) {}

    private getConnection(connectionName?: string) {
        const conn = connectionName
            ? this.connectionManager.getActiveConnection(connectionName)
            : this.connectionManager.getActiveConnections()[0];
        if (!conn) {
            const available = this.connectionManager.getActiveConnections().map(c => c.config.name);
            throw new Error(
                connectionName
                    ? `No active SSH connection "${connectionName}". Available: ${available.join(', ') || 'none'}.`
                    : `No active SSH connections. Available: ${available.join(', ') || 'none'}`
            );
        }
        return conn;
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<SSHListDirectoryInput>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { path, connectionName } = options.input;
        const conn = this.getConnection(connectionName);

        const root = conn.config.root || '/';
        const targetPath = path
            ? (path.startsWith('/') ? path : root.replace(/\/$/, '') + '/' + path)
            : root;

        // Default directory excludes
        const defaultExcludes = ['.git', 'node_modules', '.yarn', '__pycache__', '.cache', '.venv', 'vendor'];
        const excludeParts = defaultExcludes.map(e => `-name ${shellEscape(e)} -prune`).join(' -o ');

        const cmd = `find ${shellEscape(targetPath)} -maxdepth 1 \\( ${excludeParts} \\) -o -print 2>/dev/null | sort`;
        Logging.info`ChatTool sshfs_list_directory: listing contents of ${targetPath}`;

        const output = await execCommand(conn.client, cmd, token, 15_000);

        if (!output || !output.trim()) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Directory "${targetPath}" is empty or does not exist`)
            ]);
        }

        const lines = output.trim().split('\n').filter(l => l.trim());
        Logging.info`ChatTool sshfs_list_directory: ${lines.length} results`;

        // Classify each entry as file or directory
        const classifyCmd = `for f in ${lines.map(l => shellEscape(l.trim())).join(' ')}; do if [ -d "$f" ]; then echo "D $f"; else echo "F $f"; fi; done 2>/dev/null`;
        const classifyOutput = await execCommand(conn.client, classifyCmd, token, 10_000);

        let formatted: string;

        if (classifyOutput && classifyOutput.trim()) {
            const classifiedLines = classifyOutput.trim().split('\n');
            formatted = classifiedLines.map(l => {
                const isDir = l.startsWith('D ');
                const fullPath = l.substring(2).trim();
                let relativePath = fullPath;
                if (fullPath.startsWith(targetPath)) {
                    relativePath = fullPath.substring(targetPath.length).replace(/^\//, '');
                }
                if (!relativePath) return null; // Skip the directory itself
                return isDir ? `${relativePath}/` : relativePath;
            }).filter(Boolean).join('\n');
        } else {
            // Fallback: just show relative paths
            formatted = lines.map(l => {
                const trimmed = l.trim();
                if (trimmed.startsWith(targetPath)) {
                    const rel = trimmed.substring(targetPath.length).replace(/^\//, '');
                    return rel || null;
                }
                return trimmed;
            }).filter(Boolean).join('\n');
        }

        const relTarget = targetPath.startsWith(root)
            ? targetPath.substring(root.length).replace(/^\//, '') || '/'
            : targetPath;

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`Contents of ${relTarget}:\n${formatted}`)
        ]);
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<SSHListDirectoryInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const dirPath = options.input.path || '/';
        return {
            invocationMessage: `Listing contents of "${dirPath}" on SSH server...`,
        };
    }
}

/**
 * Language Model Tool — retrieves the directory tree structure of a remote project.
 * Uses the `tree` command (with `find` fallback) to show the full hierarchy in one call,
 * replacing hundreds of recursive SFTP readdir operations.
 */
class SSHDirectoryTreeTool implements vscode.LanguageModelTool<SSHDirectoryTreeInput> {
    constructor(private readonly connectionManager: ConnectionManager) {}

    private getConnection(connectionName?: string) {
        const conn = connectionName
            ? this.connectionManager.getActiveConnection(connectionName)
            : this.connectionManager.getActiveConnections()[0];
        if (!conn) {
            const available = this.connectionManager.getActiveConnections().map(c => c.config.name);
            throw new Error(
                connectionName
                    ? `No active SSH connection "${connectionName}". Available: ${available.join(', ') || 'none'}.`
                    : `No active SSH connections. Available: ${available.join(', ') || 'none'}`
            );
        }
        return conn;
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<SSHDirectoryTreeInput>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { path, connectionName } = options.input;
        // Clamp depth to 1-8, default 3
        const depth = Math.max(1, Math.min(8, options.input.depth ?? 3));
        const conn = this.getConnection(connectionName);

        const root = conn.config.root || '/';
        const targetPath = path
            ? (path.startsWith('/') ? path : root.replace(/\/$/, '') + '/' + path)
            : root;

        const defaultExcludes = ['.git', 'node_modules', '.yarn', '__pycache__', '.cache', '.venv', 'vendor'];

        Logging.info`ChatTool sshfs_directory_tree: path="${targetPath}" depth=${depth}`;

        // Try `tree` command first — produces nicely formatted output
        const treeExclude = defaultExcludes.join('|');
        const treeCmd = `tree -L ${depth} -a --noreport --dirsfirst --charset ascii -I ${shellEscape(treeExclude)} ${shellEscape(targetPath)} 2>/dev/null`;
        let output = await execCommand(conn.client, treeCmd, token, 20_000);

        if (!output || !output.trim() || output.includes('command not found')) {
            // Fallback: use find + sort and build a simple indented tree
            const excludeParts = defaultExcludes.map(e => `-name ${shellEscape(e)} -prune`).join(' -o ');
            const findCmd = `find ${shellEscape(targetPath)} -maxdepth ${depth} \\( ${excludeParts} \\) -o -print 2>/dev/null | sort`;
            const findOutput = await execCommand(conn.client, findCmd, token, 20_000);

            if (!findOutput || !findOutput.trim()) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(`Directory "${targetPath}" is empty or does not exist.`)
                ]);
            }

            // Build indented tree from flat find output
            const basePath = targetPath.replace(/\/$/, '');
            const lines = findOutput.trim().split('\n');
            const treeLines: string[] = [];

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed === basePath) continue;

                // Make relative to targetPath
                let rel = trimmed;
                if (trimmed.startsWith(basePath + '/')) {
                    rel = trimmed.substring(basePath.length + 1);
                } else if (trimmed.startsWith(basePath)) {
                    rel = trimmed.substring(basePath.length);
                }
                if (!rel) continue;

                const parts = rel.split('/');
                const indent = '  '.repeat(parts.length - 1);
                const name = parts[parts.length - 1];
                treeLines.push(`${indent}${name}`);
            }

            output = treeLines.join('\n');
        }

        // Truncate if output is too large
        const MAX_OUTPUT = 60_000;
        if (output.length > MAX_OUTPUT) {
            output = output.substring(0, MAX_OUTPUT) + '\n... [truncated — use a smaller depth or narrower path]';
        }

        // Count entries for summary
        const lineCount = output.trim().split('\n').length;

        const relTarget = targetPath.startsWith(root)
            ? targetPath.substring(root.length).replace(/^\//, '') || '/'
            : targetPath;

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
                `Directory tree of ${relTarget} (depth ${depth}, ${lineCount} entries):\n${output}`
            )
        ]);
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<SSHDirectoryTreeInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const dirPath = options.input.path || '/';
        const depth = options.input.depth ?? 3;
        return {
            invocationMessage: `Getting directory tree of "${dirPath}" (depth ${depth}) on SSH server...`,
        };
    }
}

/**
 * Language Model Tool — fast text/grep search on remote SSH server using `grep`.
 * Copilot uses this instead of the slow SFTP-based text search.
 */
class SSHSearchTextTool implements vscode.LanguageModelTool<SSHSearchTextInput> {
    constructor(private readonly connectionManager: ConnectionManager) {}

    private getConnection(connectionName?: string) {
        const conn = connectionName
            ? this.connectionManager.getActiveConnection(connectionName)
            : this.connectionManager.getActiveConnections()[0];
        if (!conn) {
            const available = this.connectionManager.getActiveConnections().map(c => c.config.name);
            throw new Error(
                connectionName
                    ? `No active SSH connection "${connectionName}". Available: ${available.join(', ') || 'none'}.`
                    : `No active SSH connections. Available: ${available.join(', ') || 'none'}`
            );
        }
        return conn;
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<SSHSearchTextInput>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { query, includePattern, path, isRegex, caseSensitive, connectionName } = options.input;
        const conn = this.getConnection(connectionName);

        const root = conn.config.root || '/';
        const searchPath = path
            ? (path.startsWith('/') ? path : root.replace(/\/$/, '') + '/' + path)
            : root;

        const MAX_RESULTS = 300;

        // Build grep flags
        const grepFlags: string[] = ['-rn', '--color=never'];
        if (!caseSensitive) grepFlags.push('-i');
        if (isRegex) {
            grepFlags.push('-E');
        } else {
            grepFlags.push('-F');
        }

        // Include pattern (e.g. "*.php", "*.css")
        if (includePattern) {
            // Support comma-separated patterns
            for (const inc of includePattern.split(',')) {
                const trimmed = inc.trim().replace(/^\*\*[/\\]/, '');
                if (trimmed) grepFlags.push(`--include=${shellEscape(trimmed)}`);
            }
        }

        // Default excludes
        const defaultExcludes = ['.git', 'node_modules', '.yarn', '__pycache__', '.cache', '.venv', 'vendor'];
        for (const exc of defaultExcludes) {
            grepFlags.push(`--exclude-dir=${shellEscape(exc)}`);
        }
        grepFlags.push('--binary-files=without-match');

        const cmd = `grep ${grepFlags.join(' ')} -- ${shellEscape(query)} ${shellEscape(searchPath)} 2>/dev/null | head -n ${MAX_RESULTS}`;

        Logging.info`ChatTool sshfs_search_text: query="${query}" include="${includePattern || '*'}" path="${searchPath}"`;

        const output = await execCommand(conn.client, cmd, token, 20_000);

        if (!output || !output.trim()) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`No matches found for "${query}" in ${searchPath}`)
            ]);
        }

        const lines = output.trim().split('\n');
        Logging.info`ChatTool sshfs_search_text: ${lines.length} matches`;

        // Format: make paths relative to root
        const formatted = lines.map(l => {
            if (l.startsWith(root)) {
                return l.substring(root.length).replace(/^\//, '');
            }
            return l;
        }).join('\n');

        const summary = lines.length >= MAX_RESULTS
            ? `Found ${MAX_RESULTS}+ matches for "${query}" (results truncated):\n`
            : `Found ${lines.length} match(es) for "${query}":\n`;

        // Truncate if needed
        let result = summary + formatted;
        const MAX_OUTPUT = 50_000;
        if (result.length > MAX_OUTPUT) {
            result = result.substring(0, MAX_OUTPUT) + `\n... [truncated at ${MAX_OUTPUT} chars]`;
        }

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(result)
        ]);
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<SSHSearchTextInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        return {
            invocationMessage: `Searching for "${options.input.query}" on SSH server...`,
        };
    }
}

/**
 * Registers Language Model Tools for Copilot agent mode.
 * Requires VS Code 1.95+ with the Language Model Tools API.
 * If the API is unavailable, registration is silently skipped.
 */
export function registerChatTools(
    connectionManager: ConnectionManager,
    subscribe: (...disposables: vscode.Disposable[]) => void
): void {
    if (typeof vscode.lm?.registerTool !== 'function') {
        Logging.debug`Language Model Tools API not available (vscode.lm.registerTool)`;
        return;
    }

    try {
        subscribe(vscode.lm.registerTool('sshfs_run_command', new SSHRunCommandTool(connectionManager)));
        Logging.info`Registered Language Model Tool: sshfs_run_command — Copilot can now execute SSH commands`;
    } catch (e) {
        Logging.warning`Failed to register sshfs_run_command: ${e}`;
    }

    try {
        subscribe(vscode.lm.registerTool('sshfs_find_files', new SSHFindFilesTool(connectionManager)));
        Logging.info`Registered Language Model Tool: sshfs_find_files — Copilot file search via 'find'`;
    } catch (e) {
        Logging.warning`Failed to register sshfs_find_files: ${e}`;
    }

    try {
        subscribe(vscode.lm.registerTool('sshfs_list_directory', new SSHListDirectoryTool(connectionManager)));
        Logging.info`Registered Language Model Tool: sshfs_list_directory — Copilot directory listing/search`;
    } catch (e) {
        Logging.warning`Failed to register sshfs_list_directory: ${e}`;
    }

    try {
        subscribe(vscode.lm.registerTool('sshfs_directory_tree', new SSHDirectoryTreeTool(connectionManager)));
        Logging.info`Registered Language Model Tool: sshfs_directory_tree — Copilot directory tree via 'tree'/'find'`;
    } catch (e) {
        Logging.warning`Failed to register sshfs_directory_tree: ${e}`;
    }

    try {
        subscribe(vscode.lm.registerTool('sshfs_search_text', new SSHSearchTextTool(connectionManager)));
        Logging.info`Registered Language Model Tool: sshfs_search_text — Copilot text search via 'grep'`;
    } catch (e) {
        Logging.warning`Failed to register sshfs_search_text: ${e}`;
    }
}
