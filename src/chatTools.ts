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
 * Input schema for the sshfs_read_file language model tool.
 */
interface SSHReadFileInput {
    path: string;
    startLine?: number;
    endLine?: number;
    connectionName?: string;
}

/**
 * Input schema for the sshfs_edit_file language model tool.
 * Supports three modes:
 * 1. Single edit: { path, oldString, newString }
 * 2. Multi-edit: { path, edits: [{oldString, newString}, ...] }
 * 3. Insert: { path, insertAfterLine, newString } (oldString omitted or empty)
 */
interface SSHEditFileInput {
    path: string;
    oldString?: string;
    newString?: string;
    edits?: { oldString: string; newString: string }[];
    insertAfterLine?: number;
    connectionName?: string;
}

/**
 * Input schema for the sshfs_create_file language model tool.
 */
interface SSHCreateFileInput {
    path: string;
    content: string;
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
 * Input schema for the sshfs_mysql_query language model tool.
 */
interface SSHMySQLQueryInput {
    query: string;
    database?: string;
    host?: string;
    user?: string;
    password?: string;
    connectionName?: string;
}

/**
 * Discovered MySQL credentials from a project config file.
 */
interface MySQLCredentials {
    host: string;
    user: string;
    password: string;
    database: string;
    /** Source file where these credentials were found */
    source: string;
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
        channel.stderr!.on('data', (chunk: Buffer) => {
            const msg = chunk.toString('utf-8').trim();
            if (msg) Logging.debug`execCommand stderr: ${msg}`;
        });
    });
}

/** Escapes a string for use in a shell command (wraps in single quotes). */
function shellEscape(str: string): string {
    return "'" + str.replace(/'/g, "'\\''") + "'";
}

/**
 * Module-level variable: when set, the SSHEditFileTool will use
 * stream.textEdit() (proposed chatParticipantAdditions API) to propose
 * inline edits in the chat UI instead of applying them via workspace.applyEdit().
 */
let _activeChatStream: any | undefined;

/**
 * Set the active ChatResponseStream for edit tool interception.
 * Called by the Chat Participant before/after invoking tools.
 */
export function setActiveChatStream(stream: any | undefined): void {
    _activeChatStream = stream;
}



/**
 * Flexible whitespace matching: finds `search` in `content` allowing
 * tab↔space differences and trailing whitespace differences on each line.
 * Returns the character offset range in the original `content`, or null if not found.
 * Sets `ambiguous: true` if multiple matches are found.
 */
function flexibleWhitespaceMatch(
    content: string,
    search: string
): { start: number; end: number; ambiguous?: boolean } | null {
    const contentLines = content.split('\n');
    const searchLines = search.split('\n');
    if (searchLines.length === 0) return null;

    // Normalize: expand tabs to 4 spaces, trim trailing whitespace
    const norm = (s: string) => s.replace(/\t/g, '    ').replace(/\s+$/, '');
    const normalizedSearch = searchLines.map(norm);

    let matchCount = 0;
    let matchStartLine = -1;

    for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
        let matches = true;
        for (let j = 0; j < searchLines.length; j++) {
            if (norm(contentLines[i + j]) !== normalizedSearch[j]) {
                matches = false;
                break;
            }
        }
        if (matches) {
            matchCount++;
            if (matchCount > 1) {
                return { start: 0, end: 0, ambiguous: true };
            }
            matchStartLine = i;
        }
    }

    if (matchCount === 1 && matchStartLine >= 0) {
        // Calculate character offsets in original content
        let start = 0;
        for (let i = 0; i < matchStartLine; i++) {
            start += contentLines[i].length + 1; // +1 for \n
        }
        let end = start;
        for (let i = 0; i < searchLines.length; i++) {
            end += contentLines[matchStartLine + i].length;
            if (i < searchLines.length - 1) end += 1; // +1 for \n
        }
        return { start, end };
    }

    return null;
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
                    ? `No active SSH connection "${connectionName}". Available: ${available.join(', ') || 'none'}. Try reconnecting or use a different connectionName.`
                    : `No active SSH connections. Tell the user to connect via SSH FS Plus first. Available connections: ${available.join(', ') || 'none'}`
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
                    ? `No active SSH connection "${connectionName}". Available: ${available.join(', ') || 'none'}. Try reconnecting or use a different connectionName.`
                    : `No active SSH connections. Tell the user to connect via SSH FS Plus first. Available connections: ${available.join(', ') || 'none'}`
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
                    ? `No active SSH connection "${connectionName}". Available: ${available.join(', ') || 'none'}. Try reconnecting or use a different connectionName.`
                    : `No active SSH connections. Tell the user to connect via SSH FS Plus first. Available connections: ${available.join(', ') || 'none'}`
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
                    ? `No active SSH connection "${connectionName}". Available: ${available.join(', ') || 'none'}. Try reconnecting or use a different connectionName.`
                    : `No active SSH connections. Tell the user to connect via SSH FS Plus first. Available connections: ${available.join(', ') || 'none'}`
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
 * Language Model Tool — reads file contents from a remote SSH server.
 * Supports reading specific line ranges (like `sed -n 'START,ENDp'`) or entire files.
 * Replaces the slow SFTP-based read_file that downloads the entire file over the network.
 * Automatically adds line numbers for easy reference.
 */
class SSHReadFileTool implements vscode.LanguageModelTool<SSHReadFileInput> {
    constructor(private readonly connectionManager: ConnectionManager) {}

    private getConnection(connectionName?: string) {
        const conn = connectionName
            ? this.connectionManager.getActiveConnection(connectionName)
            : this.connectionManager.getActiveConnections()[0];
        if (!conn) {
            const available = this.connectionManager.getActiveConnections().map(c => c.config.name);
            throw new Error(
                connectionName
                    ? `No active SSH connection "${connectionName}". Available: ${available.join(', ') || 'none'}. Try reconnecting or use a different connectionName.`
                    : `No active SSH connections. Tell the user to connect via SSH FS Plus first. Available connections: ${available.join(', ') || 'none'}`
            );
        }
        return conn;
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<SSHReadFileInput>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { path: filePath, startLine, endLine, connectionName } = options.input;
        const conn = this.getConnection(connectionName);

        const root = conn.config.root || '/';
        const absPath = filePath.startsWith('/')
            ? filePath
            : root.replace(/\/$/, '') + '/' + filePath;

        // Validate line range
        if (startLine !== undefined && startLine < 1) {
            throw new Error('startLine must be >= 1. Use startLine=1 to read from the beginning of the file.');
        }
        if (endLine !== undefined && endLine < 1) {
            throw new Error('endLine must be >= 1. Omit endLine to read to the end of the file.');
        }
        if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
            throw new Error(`endLine (${endLine}) must be >= startLine (${startLine}). Swap the values or omit endLine to read to the end.`);
        }

        // Cap maximum lines to prevent overwhelming LLM context
        const MAX_LINES = 500;
        let effectiveStart = startLine ?? 1;
        let effectiveEnd = endLine;

        if (effectiveEnd !== undefined) {
            const requested = effectiveEnd - effectiveStart + 1;
            if (requested > MAX_LINES) {
                effectiveEnd = effectiveStart + MAX_LINES - 1;
            }
        }

        // Build command
        let cmd: string;
        if (effectiveEnd !== undefined) {
            // Read specific line range with line numbers
            cmd = `sed -n '${effectiveStart},${effectiveEnd}p' ${shellEscape(absPath)} 2>/dev/null | awk 'BEGIN{n=${effectiveStart}}{printf "%d|%s\\n", n, $0; n++}'`;
        } else if (startLine !== undefined) {
            // Read from startLine to end (capped)
            cmd = `sed -n '${effectiveStart},${effectiveStart + MAX_LINES - 1}p' ${shellEscape(absPath)} 2>/dev/null | awk 'BEGIN{n=${effectiveStart}}{printf "%d|%s\\n", n, $0; n++}'`;
        } else {
            // Read entire file (capped at MAX_LINES)
            cmd = `head -n ${MAX_LINES} ${shellEscape(absPath)} 2>/dev/null | awk '{printf "%d|%s\\n", NR, $0}'`;
        }

        Logging.info`ChatTool sshfs_read_file: reading ${absPath} lines ${effectiveStart}-${effectiveEnd ?? '?'}`;

        // Check if file exists and get total line count
        const wcCmd = `wc -l < ${shellEscape(absPath)} 2>/dev/null`;
        const [output, wcOutput] = await Promise.all([
            execCommand(conn.client, cmd, token, 15_000),
            execCommand(conn.client, wcCmd, token, 5_000),
        ]);

        const totalLines = wcOutput ? parseInt(wcOutput.trim(), 10) || null : null;

        if (!output && totalLines === null) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`File not found: ${absPath}`)
            ]);
        }

        if (!output || !output.trim()) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`File is empty: ${absPath} (${totalLines ?? 0} lines total)`)
            ]);
        }

        const outputLines = output.trimEnd().split('\n');
        const relPath = absPath.startsWith(root)
            ? absPath.substring(root.length).replace(/^\//, '')
            : absPath;

        // Build header
        let header: string;
        if (startLine !== undefined || endLine !== undefined) {
            const actualEnd = effectiveStart + outputLines.length - 1;
            header = `${relPath} — lines ${effectiveStart}–${actualEnd}`;
            if (totalLines) header += ` of ${totalLines}`;
        } else {
            header = `${relPath}`;
            if (totalLines) header += ` — ${totalLines} lines total`;
            if (totalLines && totalLines > MAX_LINES) {
                header += ` (showing first ${MAX_LINES})`;
            }
        }

        // Truncate output if too large
        let result = header + '\n' + output.trimEnd();
        const MAX_OUTPUT = 60_000;
        if (result.length > MAX_OUTPUT) {
            result = result.substring(0, MAX_OUTPUT) + '\n... [truncated at ' + MAX_OUTPUT + ' chars]';
        }

        Logging.info`ChatTool sshfs_read_file: returned ${outputLines.length} lines`;

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(result)
        ]);
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<SSHReadFileInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const { path: filePath, startLine, endLine } = options.input;
        let msg = `Reading ${filePath}`;
        if (startLine !== undefined || endLine !== undefined) {
            msg += ` (lines ${startLine ?? 1}–${endLine ?? 'end'})`;
        }
        msg += ' on SSH server...';
        return { invocationMessage: msg };
    }
}

/**
 * Language Model Tool — edits files on a remote SSH server via VS Code WorkspaceEdit.
 * Opens the file through the SSH FS filesystem provider, performs an exact string
 * replacement via WorkspaceEdit API, which gives full undo/redo support.
 * The file is left in a dirty (unsaved) state so the user can review and save manually.
 */
class SSHEditFileTool implements vscode.LanguageModelTool<SSHEditFileInput> {
    constructor(private readonly connectionManager: ConnectionManager) {}

    private getConnection(connectionName?: string) {
        const conn = connectionName
            ? this.connectionManager.getActiveConnection(connectionName)
            : this.connectionManager.getActiveConnections()[0];
        if (!conn) {
            const available = this.connectionManager.getActiveConnections().map(c => c.config.name);
            throw new Error(
                connectionName
                    ? `No active SSH connection "${connectionName}". Available: ${available.join(', ') || 'none'}. Try reconnecting or use a different connectionName.`
                    : `No active SSH connections. Tell the user to connect via SSH FS Plus first. Available connections: ${available.join(', ') || 'none'}`
            );
        }
        return conn;
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<SSHEditFileInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { path: filePath, connectionName, insertAfterLine } = options.input;
        const conn = this.getConnection(connectionName);

        const root = conn.config.root || '/';
        // Build path relative to root for the ssh:// URI
        let relPath: string;
        if (filePath.startsWith('/')) {
            if (filePath.startsWith(root)) {
                relPath = filePath.substring(root.length).replace(/^\//, '');
            } else {
                relPath = filePath;
            }
        } else {
            relPath = filePath;
        }

        const absPath = root.replace(/\/$/, '') + '/' + relPath;
        const uri = vscode.Uri.parse(`ssh://${conn.config.name}/${absPath.replace(/^\//, '')}`);

        // Open the file
        let doc: vscode.TextDocument;
        try {
            doc = await vscode.workspace.openTextDocument(uri);
        } catch (e) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Error: Could not open file ${absPath}: ${e instanceof Error ? e.message : String(e)}`)
            ]);
        }

        let content = doc.getText();

        // Size guard
        if (content.length > 2_000_000) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Error: File ${absPath} is too large (${(content.length / 1_000_000).toFixed(1)} MB). Maximum supported size is 2 MB.`)
            ]);
        }

        // --- Determine edit mode ---
        // Mode 1: Insert after line
        if (insertAfterLine !== undefined) {
            const newString = (options.input.newString ?? '').replace(/\r\n/g, '\n');
            if (!newString) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(`Error: newString is required for insert mode. Provide the text to insert in the newString parameter.`)
                ]);
            }
            return this.applyInsert(doc, uri, absPath, relPath, insertAfterLine, newString);
        }

        // Mode 2: Multi-edit (edits array)
        if (options.input.edits && options.input.edits.length > 0) {
            return this.applyMultiEdit(doc, uri, absPath, relPath, options.input.edits);
        }

        // Mode 3: Single edit (classic oldString/newString)
        const oldString = options.input.oldString ?? '';
        const newString = options.input.newString ?? '';
        if (!oldString) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Error: oldString is required for replace mode. Use insertAfterLine for insert mode, or edits[] for multi-edit.`)
            ]);
        }

        Logging.info`ChatTool sshfs_edit_file: editing ${absPath} via WorkspaceEdit (uri: ${uri.toString()})`;
        return this.applySingleEdit(doc, uri, absPath, relPath, oldString, newString);
    }

    /**
     * Insert newString after a specific line number.
     */
    private async applyInsert(
        doc: vscode.TextDocument, uri: vscode.Uri,
        absPath: string, relPath: string,
        afterLine: number, newString: string
    ): Promise<vscode.LanguageModelToolResult> {
        const totalLines = doc.lineCount;
        if (afterLine < 0 || afterLine > totalLines) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Error: insertAfterLine ${afterLine} is out of range (file has ${totalLines} lines). Use 0 to insert at the beginning.`)
            ]);
        }

        // Position: end of the specified line (or start of file for line 0)
        const insertPos = afterLine === 0
            ? new vscode.Position(0, 0)
            : doc.lineAt(afterLine - 1).range.end;

        const textToInsert = afterLine === 0 ? newString + '\n' : '\n' + newString;
        const insertedLines = newString.split('\n').length;

        Logging.info`ChatTool sshfs_edit_file: inserting ${insertedLines} line(s) after line ${afterLine} in ${relPath}`;

        const chatStream = _activeChatStream;
        if (chatStream && typeof chatStream.textEdit === 'function') {
            chatStream.textEdit(uri, [new vscode.TextEdit(new vscode.Range(insertPos, insertPos), textToInsert)]);
            chatStream.textEdit(uri, true);
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Successfully proposed insertion of ${insertedLines} line(s) after line ${afterLine} in ${relPath}. The edit is shown as an inline diff.`)
            ]);
        }

        const edit = new vscode.WorkspaceEdit();
        edit.insert(uri, insertPos, textToInsert);
        const success = await vscode.workspace.applyEdit(edit);
        if (!success) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Error: VS Code rejected the insert for ${absPath}. Try re-reading the file with sshfs_read_file to verify its current state and retry.`)
            ]);
        }
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`Successfully inserted ${insertedLines} line(s) after line ${afterLine} in ${relPath}. The file is modified but NOT yet saved.`)
        ]);
    }

    /**
     * Apply multiple edits to the same file in one pass.
     * Edits are applied bottom-to-top to preserve line offsets.
     */
    private async applyMultiEdit(
        doc: vscode.TextDocument, uri: vscode.Uri,
        absPath: string, relPath: string,
        edits: { oldString: string; newString: string }[]
    ): Promise<vscode.LanguageModelToolResult> {
        if (edits.length > 20) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Error: Too many edits (${edits.length}). Maximum is 20 per call. Split into multiple sshfs_edit_file calls with up to 20 edits each.`)
            ]);
        }

        const content = doc.getText();
        Logging.info`ChatTool sshfs_edit_file: multi-edit with ${edits.length} edits in ${relPath}`;

        // Find all matches first (validate before applying any)
        const matches: { index: number; matchedString: string; normalizedNew: string; editIdx: number }[] = [];

        for (let i = 0; i < edits.length; i++) {
            const { oldString, newString } = edits[i];
            const normalizedOld = oldString.replace(/\r\n/g, '\n');
            const normalizedNew = newString.replace(/\r\n/g, '\n');

            let index = content.indexOf(oldString);
            let matchedString = oldString;

            if (index === -1 && normalizedOld !== oldString) {
                index = content.indexOf(normalizedOld);
                matchedString = normalizedOld;
            }
            if (index === -1) {
                const flexResult = flexibleWhitespaceMatch(content, normalizedOld);
                if (flexResult && !flexResult.ambiguous) {
                    index = flexResult.start;
                    matchedString = content.substring(flexResult.start, flexResult.end);
                }
            }

            if (index === -1) {
                // Try to provide a helpful hint about where the text might be
                const firstLine = normalizedOld.split('\n')[0].trim();
                let hint = '';
                if (firstLine.length > 10) {
                    const firstLineIdx = content.indexOf(firstLine);
                    if (firstLineIdx !== -1) {
                        const lineNum = content.substring(0, firstLineIdx).split('\n').length;
                        const contextStart = Math.max(0, content.lastIndexOf('\n', Math.max(0, firstLineIdx - 1)) + 1);
                        const contextEndNewline = content.indexOf('\n', firstLineIdx);
                        const nextLine = contextEndNewline !== -1 ? content.indexOf('\n', contextEndNewline + 1) : -1;
                        const contextEnd = nextLine !== -1 ? nextLine : content.length;
                        const actualContext = content.substring(contextStart, contextEnd);
                        hint = `\n\nPartial match at line ${lineNum}. Actual content:\n${actualContext}\n\nCheck for whitespace differences.`;
                    }
                }
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(`Error: Edit ${i + 1}/${edits.length} — oldString not found in ${absPath}. No edits were applied. Use sshfs_read_file to re-read the file.${hint}`)
                ]);
            }

            const secondIndex = content.indexOf(matchedString, index + 1);
            if (secondIndex !== -1) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(`Error: Edit ${i + 1}/${edits.length} — oldString matches multiple locations in ${absPath}. No edits were applied. Add more context.`)
                ]);
            }

            matches.push({ index, matchedString, normalizedNew, editIdx: i });
        }

        // Check for overlapping edits
        const sorted = [...matches].sort((a, b) => a.index - b.index);
        for (let i = 1; i < sorted.length; i++) {
            const prev = sorted[i - 1];
            if (prev.index + prev.matchedString.length > sorted[i].index) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(`Error: Edits ${prev.editIdx + 1} and ${sorted[i].editIdx + 1} overlap. No edits were applied.`)
                ]);
            }
        }

        // Build TextEdits (bottom-to-top for stable offsets)
        const textEdits: vscode.TextEdit[] = sorted.reverse().map(m => {
            const startPos = doc.positionAt(m.index);
            const endPos = doc.positionAt(m.index + m.matchedString.length);
            return new vscode.TextEdit(new vscode.Range(startPos, endPos), m.normalizedNew);
        });

        const chatStream = _activeChatStream;
        if (chatStream && typeof chatStream.textEdit === 'function') {
            chatStream.textEdit(uri, textEdits);
            chatStream.textEdit(uri, true);
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Successfully proposed ${edits.length} edits in ${relPath}. The changes are shown as inline diffs.`)
            ]);
        }

        const wsEdit = new vscode.WorkspaceEdit();
        for (const te of textEdits) {
            wsEdit.replace(uri, te.range, te.newText);
        }
        const success = await vscode.workspace.applyEdit(wsEdit);
        if (!success) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Error: VS Code rejected the multi-edit for ${absPath}. Try re-reading the file with sshfs_read_file and retrying with the correct content.`)
            ]);
        }

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`Successfully applied ${edits.length} edits to ${relPath}. The file is modified but NOT yet saved.`)
        ]);
    }

    /**
     * Classic single find-and-replace edit.
     */
    private async applySingleEdit(
        doc: vscode.TextDocument, uri: vscode.Uri,
        absPath: string, relPath: string,
        oldString: string, newString: string
    ): Promise<vscode.LanguageModelToolResult> {
        const content = doc.getText();

        const normalizedOld = oldString.replace(/\r\n/g, '\n');
        const normalizedNew = newString.replace(/\r\n/g, '\n');

        // --- Matching logic ---
        // 1. Try exact match
        let index = content.indexOf(oldString);
        let matchedString = oldString;
        // 2. Try with normalized line endings
        if (index === -1 && normalizedOld !== oldString) {
            index = content.indexOf(normalizedOld);
            matchedString = normalizedOld;
        }
        // 3. Flexible whitespace match (handles tab↔space differences, trailing whitespace)
        if (index === -1) {
            const flexResult = flexibleWhitespaceMatch(content, normalizedOld);
            if (flexResult) {
                if (flexResult.ambiguous) {
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart(`Error: The specified oldString matches multiple locations in ${absPath} (with whitespace normalization). The file was NOT modified. Include more surrounding context to make the match unique.`)
                    ]);
                }
                index = flexResult.start;
                matchedString = content.substring(flexResult.start, flexResult.end);
                Logging.info`ChatTool sshfs_edit_file: exact match failed, using flexible whitespace match at offset ${index}`;
            }
        }

        if (index === -1) {
            // Try to help: search for the first line of oldString to show where it might be
            const firstLine = normalizedOld.split('\n')[0].trim();
            let hint = '';
            if (firstLine.length > 10) {
                const firstLineIdx = content.indexOf(firstLine);
                if (firstLineIdx !== -1) {
                    const lineNum = content.substring(0, firstLineIdx).split('\n').length;
                    // Show the actual content around the match
                    const contextStart = Math.max(0, content.lastIndexOf('\n', Math.max(0, firstLineIdx - 1)) + 1);
                    const contextEndNewline = content.indexOf('\n', firstLineIdx);
                    const nextLine = contextEndNewline !== -1 ? content.indexOf('\n', contextEndNewline + 1) : -1;
                    const contextEnd = nextLine !== -1 ? nextLine : content.length;
                    const actualContext = content.substring(contextStart, contextEnd);
                    hint = `\n\nPartial match found at line ${lineNum}. The first line was found but the full multi-line text does not match. Actual content around line ${lineNum}:\n${actualContext}\n\nCheck for whitespace differences (tabs vs spaces, trailing spaces, line endings).`;
                }
            }
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Error: The specified oldString was not found in ${absPath}. The file was NOT modified.${hint}\n\nUse sshfs_read_file to re-read the exact content and try again with the exact text.`)
            ]);
        }

        // Check for multiple matches
        const secondIndex = content.indexOf(matchedString, index + 1);
        if (secondIndex !== -1) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Error: The specified oldString appears multiple times in ${absPath}. The file was NOT modified. Include more surrounding context (3-5 lines before and after) to make the match unique.`)
            ]);
        }

        // Convert string offset to Position range
        const startPos = doc.positionAt(index);
        const endPos = doc.positionAt(index + matchedString.length);
        const range = new vscode.Range(startPos, endPos);

        // If we used flexible matching, the newString may also have wrong indentation
        // (Copilot constructed it based on sshfs_read_file output which may differ).
        // Adjust newString indentation to match the actual file's indentation style.
        let finalNew = normalizedNew;
        if (matchedString !== oldString && matchedString !== normalizedOld) {
            // Flexible match was used — try to fix indentation in newString
            const oldLines = normalizedOld.split('\n');
            const matchedLines = matchedString.split('\n');
            const newLines = finalNew.split('\n');

            const adjustedLines = newLines.map(newLine => {
                // For each new line, check if its leading whitespace matches any old line
                const newTrimmed = newLine.replace(/^\s+/, '');
                if (!newTrimmed) return newLine; // blank line, keep as-is

                // Find the old line with the same trimmed content or similar indentation
                for (let i = 0; i < oldLines.length; i++) {
                    const oldTrimmed = oldLines[i].replace(/^\s+/, '');
                    const oldIndent = oldLines[i].substring(0, oldLines[i].length - oldTrimmed.length);
                    const newIndent = newLine.substring(0, newLine.length - newTrimmed.length);

                    if (oldIndent === newIndent && i < matchedLines.length) {
                        // Same indentation as oldString line — use matched (actual) indentation
                        const matchedTrimmed = matchedLines[i].replace(/^\s+/, '');
                        const matchedIndent = matchedLines[i].substring(0, matchedLines[i].length - matchedTrimmed.length);
                        return matchedIndent + newTrimmed;
                    }
                }
                return newLine; // no mapping found, keep as-is
            });
            finalNew = adjustedLines.join('\n');
        }

        // Apply edit via WorkspaceEdit — this gives undo/redo, dirty flag, etc.
        // OR use stream.textEdit() for inline diff in chat participant context
        const chatStream = _activeChatStream;
        if (chatStream && typeof chatStream.textEdit === 'function') {
            // Chat Participant context: propose edits via textEdit (inline green/red diff)
            const textEdits = [new vscode.TextEdit(range, finalNew)];
            chatStream.textEdit(uri, textEdits);
            chatStream.textEdit(uri, true); // signal editing is done for this file

            // Calculate summary
            const lineNumber = startPos.line + 1;
            const oldLineCount = matchedString.split('\n').length;
            const newLineCount = finalNew.split('\n').length;

            Logging.info`ChatTool sshfs_edit_file: proposed ${oldLineCount} → ${newLineCount} line(s) via textEdit at line ${lineNumber} in ${relPath}`;

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    `Successfully proposed edit for ${relPath} — replaced ${oldLineCount} line(s) with ${newLineCount} line(s) at line ${lineNumber}. The edit is shown as an inline diff in the chat. The user can accept or reject the changes.`
                )
            ]);
        }

        // Normal agent mode: apply directly via workspace.applyEdit()
        const edit = new vscode.WorkspaceEdit();
        edit.replace(uri, range, finalNew);

        const success = await vscode.workspace.applyEdit(edit);

        if (!success) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Error: VS Code rejected the edit for ${absPath}. The file was NOT modified. Try re-reading the file with sshfs_read_file and retrying with the correct content.`)
            ]);
        }

        // Calculate summary
        const lineNumber = startPos.line + 1;
        const oldLineCount = matchedString.split('\n').length;
        const newLineCount = finalNew.split('\n').length;

        Logging.info`ChatTool sshfs_edit_file: replaced ${oldLineCount} line(s) with ${newLineCount} line(s) at line ${lineNumber} in ${relPath}`;

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
                `Successfully edited ${relPath} — replaced ${oldLineCount} line(s) with ${newLineCount} line(s) at line ${lineNumber}. The file is modified but NOT yet saved. The user can review changes in the editor and save with Ctrl+S, or undo with Ctrl+Z.`
            )
        ]);
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<SSHEditFileInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const filePath = options.input.path;
        const { edits, insertAfterLine, oldString, newString } = options.input;

        if (insertAfterLine !== undefined) {
            const lineCount = (newString ?? '').split('\n').length;
            return {
                invocationMessage: `Insert ${lineCount} line(s) after line ${insertAfterLine} in **${filePath}**`,
            };
        }

        if (edits && edits.length > 0) {
            return {
                invocationMessage: `Apply ${edits.length} edits to **${filePath}** on SSH server`,
            };
        }

        // Single edit
        const oldStr = oldString ?? '';
        const newStr = newString ?? '';
        const maxPreview = 300;
        const oldPreview = oldStr.length > maxPreview ? oldStr.substring(0, maxPreview) + '...' : oldStr;
        const newPreview = newStr.length > maxPreview ? newStr.substring(0, maxPreview) + '...' : newStr;

        return {
            invocationMessage: `Edit **${filePath}** on SSH server`,
            confirmationMessages: {
                title: 'SSH File Edit',
                message: new vscode.MarkdownString(
                    `Edit **${filePath}**\n\nReplace:\n\`\`\`\n${oldPreview}\n\`\`\`\n\nWith:\n\`\`\`\n${newPreview}\n\`\`\``
                )
            },
        };
    }
}

/**
 * Language Model Tool — creates a new file on a remote SSH server.
 * Opens the file through VS Code's TextDocument API (using the SSH FS provider),
 * writes the content via WorkspaceEdit, and leaves it in a dirty (unsaved) state
 * so the user can review and save manually. Supports chat participant inline diffs.
 */
class SSHCreateFileTool implements vscode.LanguageModelTool<SSHCreateFileInput> {
    constructor(private readonly connectionManager: ConnectionManager) {}

    private getConnection(connectionName?: string) {
        const conn = connectionName
            ? this.connectionManager.getActiveConnection(connectionName)
            : this.connectionManager.getActiveConnections()[0];
        if (!conn) {
            const available = this.connectionManager.getActiveConnections().map(c => c.config.name);
            throw new Error(
                connectionName
                    ? `No active SSH connection "${connectionName}". Available: ${available.join(', ') || 'none'}. Try reconnecting or use a different connectionName.`
                    : `No active SSH connections. Tell the user to connect via SSH FS Plus first. Available connections: ${available.join(', ') || 'none'}`
            );
        }
        return conn;
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<SSHCreateFileInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { path: filePath, content, connectionName } = options.input;
        const conn = this.getConnection(connectionName);

        const root = conn.config.root || '/';
        // Build absolute path
        const absPath = filePath.startsWith('/')
            ? filePath
            : root.replace(/\/$/, '') + '/' + filePath;

        // Build ssh:// URI
        const uri = vscode.Uri.parse(`ssh://${conn.config.name}/${absPath.replace(/^\//, '')}`);

        Logging.info`ChatTool sshfs_create_file: creating ${absPath} (${content.length} chars)`;

        // Check if file already exists
        try {
            await vscode.workspace.fs.stat(uri);
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Error: File already exists at ${absPath}. Use sshfs_edit_file to modify existing files, or choose a different path.`)
            ]);
        } catch {
            // File doesn't exist — good, we can create it
        }

        // Size guard
        if (content.length > 2_000_000) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Error: Content too large (${(content.length / 1_000_000).toFixed(1)} MB). Maximum supported size is 2 MB.`)
            ]);
        }

        // Normalize line endings
        const normalizedContent = content.replace(/\r\n/g, '\n');

        const relPath = absPath.startsWith(root)
            ? absPath.substring(root.length).replace(/^\//, '')
            : absPath;
        const lineCount = normalizedContent.split('\n').length;

        // If we're in chat participant context, propose via textEdit (inline green diff)
        const chatStream = _activeChatStream;
        if (chatStream && typeof chatStream.textEdit === 'function') {
            // Create the file first (empty) so the URI is valid for textEdit
            await vscode.workspace.fs.writeFile(uri, Buffer.of());
            const doc = await vscode.workspace.openTextDocument(uri);
            const range = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
            chatStream.textEdit(uri, [new vscode.TextEdit(range, normalizedContent)]);
            chatStream.textEdit(uri, true);

            Logging.info`ChatTool sshfs_create_file: proposed ${lineCount} line(s) via textEdit for ${relPath}`;

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    `Successfully proposed new file ${relPath} (${lineCount} lines). The edit is shown as an inline diff in the chat. The user can accept or reject the changes.`
                )
            ]);
        }

        // Normal agent mode: create via WorkspaceEdit
        const edit = new vscode.WorkspaceEdit();
        edit.createFile(uri, { overwrite: false, ignoreIfExists: false });
        edit.insert(uri, new vscode.Position(0, 0), normalizedContent);

        const success = await vscode.workspace.applyEdit(edit);
        if (!success) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Error: VS Code rejected the file creation for ${absPath}. The directory may not exist — try creating it first with sshfs_run_command, or check the path is correct.`)
            ]);
        }

        Logging.info`ChatTool sshfs_create_file: created ${relPath} with ${lineCount} line(s)`;

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
                `Successfully created ${relPath} with ${lineCount} line(s). The file is modified but NOT yet saved. The user can review and save with Ctrl+S, or undo with Ctrl+Z.`
            )
        ]);
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<SSHCreateFileInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const filePath = options.input.path;
        const contentLen = options.input.content.length;
        const lineCount = options.input.content.split('\n').length;

        return {
            invocationMessage: `Create **${filePath}** on SSH server (${lineCount} lines)`,
            confirmationMessages: {
                title: 'SSH Create File',
                message: new vscode.MarkdownString(
                    `Create new file **${filePath}** (${lineCount} lines, ${contentLen} chars)`
                )
            },
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
                    ? `No active SSH connection "${connectionName}". Available: ${available.join(', ') || 'none'}. Try reconnecting or use a different connectionName.`
                    : `No active SSH connections. Tell the user to connect via SSH FS Plus first. Available connections: ${available.join(', ') || 'none'}`
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

        // Detect if path looks like a file (has an extension) vs directory
        const looksLikeFile = path ? /\.[a-zA-Z0-9]{1,10}$/.test(path) : false;

        // Build grep flags
        const grepFlags: string[] = ['-n', '--color=never'];
        if (!looksLikeFile) {
            grepFlags.push('-r'); // recursive only for directory searches
        }
        if (!caseSensitive) grepFlags.push('-i');

        // Auto-detect regex metacharacters: if the query contains | ( ) [ ] { } + ? ^ $
        // but isRegex wasn't explicitly set, auto-enable extended regex mode.
        // This prevents wasted round-trips when Copilot sends alternation patterns like "word1|word2".
        const useRegex = isRegex || /[|()[\]{}+?^$]/.test(query);
        if (useRegex) {
            grepFlags.push('-E');
        } else {
            grepFlags.push('-F');
        }

        // Include pattern and directory excludes only for directory searches
        if (!looksLikeFile) {
            if (includePattern) {
                for (const inc of includePattern.split(',')) {
                    const trimmed = inc.trim().replace(/^\*\*[/\\]/, '');
                    if (trimmed) grepFlags.push(`--include=${shellEscape(trimmed)}`);
                }
            }

            const defaultExcludes = ['.git', 'node_modules', '.yarn', '__pycache__', '.cache', '.venv', 'vendor'];
            for (const exc of defaultExcludes) {
                grepFlags.push(`--exclude-dir=${shellEscape(exc)}`);
            }
        }
        grepFlags.push('--binary-files=without-match');

        const cmd = `grep ${grepFlags.join(' ')} -- ${shellEscape(query)} ${shellEscape(searchPath)} 2>/dev/null | head -n ${MAX_RESULTS}`;

        Logging.info`ChatTool sshfs_search_text: query="${query}" include="${includePattern || '*'}" path="${searchPath}"`;

        const output = await execCommand(conn.client, cmd, token, 20_000);

        if (!output || !output.trim()) {
            Logging.info`ChatTool sshfs_search_text: 0 matches`;
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`No matches found for "${query}" in ${searchPath}. Try a different search query, broader pattern, or check if the path is correct.`)
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

// ─── MySQL Query Tool ───────────────────────────────────────────────────────────

/** In-memory cache of discovered MySQL credentials per SSH connection name. */
const mysqlCredentialsCache = new Map<string, MySQLCredentials>();

/**
 * Auto-discovers MySQL/MariaDB credentials from project config files on the
 * remote server. Searches generically for common patterns across PHP configs,
 * .env files, YAML, INI, and XML files — not limited to specific CMS frameworks.
 *
 * Returns the first complete set of credentials found, or null if none.
 */
async function discoverMySQLCredentials(
    client: Client,
    root: string,
    token?: vscode.CancellationToken
): Promise<MySQLCredentials | null> {
    // 1. Find candidate files that likely contain DB config (max depth 4)
    const findCmd = `find ${shellEscape(root)} -maxdepth 4 -type f \\( ` +
        `-name 'configuration.php' -o -name 'wp-config.php' -o -name 'config.php' ` +
        `-o -name '.env' -o -name '*.env' -o -name 'database.php' -o -name 'db.php' ` +
        `-o -name 'settings.php' -o -name 'local.php' -o -name 'app.ini' ` +
        `-o -name 'config.yml' -o -name 'config.yaml' -o -name 'parameters.yml' ` +
        `-o -name 'config.json' -o -name 'database.yml' -o -name 'database.yaml' ` +
        `\\) ! -path '*/vendor/*' ! -path '*/node_modules/*' ! -path '*/.git/*' 2>/dev/null | head -20`;

    const files = await execCommand(client, findCmd, token, 10_000);
    if (!files) return null;

    const filePaths = files.trim().split('\n').filter(f => f.trim());
    if (filePaths.length === 0) return null;

    // 2. Read each candidate file and try to extract credentials
    for (const filePath of filePaths) {
        const content = await execCommand(client, `cat ${shellEscape(filePath.trim())}`, token, 5_000);
        if (!content) continue;

        const creds = parseMySQLCredentials(content, filePath.trim());
        if (creds && creds.database) {
            return creds;
        }
    }

    return null;
}

/**
 * Parses MySQL credentials from file content using multiple patterns
 * (PHP variables/defines/arrays, .env KEY=VALUE, YAML key: value).
 */
function parseMySQLCredentials(content: string, source: string): MySQLCredentials | null {
    const result: Partial<MySQLCredentials> = { source };

    // Patterns for host (require db/DB prefix for variable/env patterns)
    const hostPatterns = [
        /(?:\$(?:db_?)host|(?:DB_?)HOST|db\.host|database\.host)\s*[=:]\s*['"]([^'"]+)['"]/i,
        /define\s*\(\s*['"]DB_HOST['"]\s*,\s*['"]([^'"]+)['"]/i,
        /['"](?:db_?)?host['"]\s*=>\s*['"]([^'"]+)['"]/i,
    ];

    // Patterns for username (require db/DB prefix for variable/env patterns)
    const userPatterns = [
        /(?:\$(?:db_?)user(?:name)?|(?:DB_?)USER(?:NAME)?|db\.user(?:name)?|database\.user(?:name)?)\s*[=:]\s*['"]([^'"]+)['"]/i,
        /define\s*\(\s*['"]DB_USER(?:NAME)?['"]\s*,\s*['"]([^'"]+)['"]/i,
        /['"](?:db_?)?user(?:name)?['"]\s*=>\s*['"]([^'"]+)['"]/i,
    ];

    // Patterns for password (require db/DB prefix for variable/env patterns)
    const passwordPatterns = [
        /(?:\$(?:db_?)pass(?:word)?|(?:DB_?)PASS(?:WORD)?|db\.pass(?:word)?|database\.pass(?:word)?)\s*[=:]\s*['"]([^'"]*)['"]/i,
        /define\s*\(\s*['"]DB_PASS(?:WORD)?['"]\s*,\s*['"]([^'"]*)['"]/i,
        /['"](?:db_?)?pass(?:word)?['"]\s*=>\s*['"]([^'"]*)['"]/i,
    ];

    // Patterns for database name (require db/DB prefix for variable/env patterns)
    const databasePatterns = [
        /(?:\$(?:db_?)(?:name|database)|(?:DB_?)(?:NAME|DATABASE)|db\.(?:name|database)|database\.(?:name|database))\s*[=:]\s*['"]([^'"]+)['"]/i,
        /define\s*\(\s*['"]DB_NAME['"]\s*,\s*['"]([^'"]+)['"]/i,
        /['"](?:db_?(?:name)?|database)['"]\s*=>\s*['"]([^'"]+)['"]/i,
    ];

    for (const p of hostPatterns) {
        const m = content.match(p);
        if (m) { result.host = m[1]; break; }
    }
    for (const p of userPatterns) {
        const m = content.match(p);
        if (m) { result.user = m[1]; break; }
    }
    for (const p of passwordPatterns) {
        const m = content.match(p);
        if (m) { result.password = m[1]; break; }
    }
    for (const p of databasePatterns) {
        const m = content.match(p);
        if (m) { result.database = m[1]; break; }
    }

    // Need at least a database name to consider this valid
    // MySQL database names cannot contain spaces — reject false positives like APP_NAME
    if (!result.database || /\s/.test(result.database)) return null;

    // Normalize 'localhost' → '127.0.0.1' to force TCP/IP (localhost uses Unix socket which often fails)
    const host = result.host === 'localhost' ? '127.0.0.1' : (result.host || '127.0.0.1');
    return {
        host,
        user: result.user || 'root',
        password: result.password || '',
        database: result.database,
        source: result.source || source,
    };
}

/**
 * Determines whether a SQL query is read-only (SELECT, SHOW, DESCRIBE, EXPLAIN)
 * or a write operation (INSERT, UPDATE, DELETE, DROP, ALTER, TRUNCATE, CREATE, etc.).
 */
function isReadOnlySQL(query: string): boolean {
    const trimmed = query.trim().replace(/^\/\*.*?\*\//s, '').trim();
    return /^(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN|HELP)\b/i.test(trimmed);
}

/**
 * Formats tab-separated MySQL --batch output into a readable aligned table.
 */
function formatMySQLOutput(raw: string): string {
    const lines = raw.split('\n').filter(l => l.length > 0);
    if (lines.length === 0) return '(no results)';

    const rows = lines.map(line => line.split('\t'));
    if (rows.length === 0) return '(no results)';

    // Calculate column widths
    const colCount = rows[0].length;
    const widths: number[] = new Array(colCount).fill(0);
    for (const row of rows) {
        for (let i = 0; i < Math.min(row.length, colCount); i++) {
            widths[i] = Math.max(widths[i], row[i].length);
        }
    }

    // Format as aligned table with header separator
    const formatted: string[] = [];
    for (let r = 0; r < rows.length; r++) {
        const cells = rows[r].map((cell, i) => cell.padEnd(widths[i] || 0));
        formatted.push(cells.join(' | '));
        if (r === 0) {
            formatted.push(widths.map(w => '-'.repeat(w)).join('-+-'));
        }
    }

    return formatted.join('\n');
}

/**
 * Language Model Tool — allows Copilot to execute MySQL/MariaDB queries
 * on the remote SSH server. Auto-discovers DB credentials from project
 * config files. On first use, shows discovered credentials for user
 * confirmation. Write queries can require confirmation (configurable
 * per server via `mysqlConfirmWrites`).
 */
class SSHMySQLQueryTool implements vscode.LanguageModelTool<SSHMySQLQueryInput> {
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
                    : `No active SSH connections. Connect via SSH FS Plus first. Available: ${available.join(', ') || 'none'}`
            );
        }
        return conn;
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<SSHMySQLQueryInput>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { query, connectionName } = options.input;
        const conn = this.getConnection(connectionName);
        const connName = conn.config.name;
        const root = conn.config.root || '/';

        // Resolve credentials: explicit params > cache > auto-discover
        let creds: MySQLCredentials;

        if (options.input.host || options.input.user || options.input.password || options.input.database) {
            // Explicit credentials provided by the agent
            // Normalize 'localhost' → '127.0.0.1' to force TCP/IP (Unix socket often fails)
            const explicitHost = options.input.host === 'localhost' ? '127.0.0.1' : options.input.host;
            creds = {
                host: explicitHost || mysqlCredentialsCache.get(connName)?.host || '127.0.0.1',
                user: options.input.user || mysqlCredentialsCache.get(connName)?.user || 'root',
                password: options.input.password ?? mysqlCredentialsCache.get(connName)?.password ?? '',
                database: options.input.database || mysqlCredentialsCache.get(connName)?.database || '',
                source: 'explicit parameters',
            };
            // Update cache with explicit overrides
            mysqlCredentialsCache.set(connName, creds);
        } else if (mysqlCredentialsCache.has(connName)) {
            creds = mysqlCredentialsCache.get(connName)!;
        } else {
            // Auto-discover
            Logging.info`ChatTool sshfs_mysql_query: discovering MySQL credentials on ${connName}`;
            const discovered = await discoverMySQLCredentials(conn.client, root, token);
            if (!discovered) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        `No MySQL credentials found in project files on "${connName}" (searched ${root} for config files up to 4 levels deep).\n\n` +
                        `Please provide credentials explicitly by calling this tool with host, user, password, and database parameters, ` +
                        `or ask the user for the database connection details.`
                    )
                ]);
            }
            mysqlCredentialsCache.set(connName, discovered);
            creds = discovered;
            Logging.info`ChatTool sshfs_mysql_query: found credentials in ${discovered.source} (db: ${discovered.database}, host: ${discovered.host})`;
        }

        // Use database override if provided in this call
        const database = options.input.database || creds.database;

        // Build the mysql command
        // MYSQL_PWD env var is used instead of -p to avoid password in process list
        const mysqlCmd = `MYSQL_PWD=${shellEscape(creds.password)} mysql` +
            ` -h ${shellEscape(creds.host)}` +
            ` -u ${shellEscape(creds.user)}` +
            (database ? ` ${shellEscape(database)}` : '') +
            ` --batch --column-names` +
            ` -e ${shellEscape(query)}`;

        Logging.info`ChatTool sshfs_mysql_query: executing query on ${connName} (db: ${database || 'none'})`;
        Logging.debug`ChatTool sshfs_mysql_query: ${query.substring(0, 200)}`;

        // Execute with 30s timeout
        const channel = await toPromise<ClientChannel>(cb => conn.client.exec(mysqlCmd, cb)).catch(e => {
            throw new Error(
                `Failed to execute MySQL command on "${connName}": ${e instanceof Error ? e.message : String(e)}. ` +
                `The SSH connection may have been lost.`
            );
        });

        const output = await new Promise<string>((resolve) => {
            const stdoutChunks: string[] = [];
            const stderrChunks: string[] = [];
            let resolved = false;

            const finish = (result: string) => {
                if (resolved) return;
                resolved = true;
                clearTimeout(timer);
                cancelDispose?.dispose();
                resolve(result);
            };

            const timer = setTimeout(() => {
                channel.close();
                const partial = stdoutChunks.join('');
                finish(partial ? partial + '\n... [query timed out after 30s]' : '(query timed out after 30s with no output)');
            }, 30_000);

            const cancelDispose = token?.onCancellationRequested(() => {
                channel.close();
                finish('[Query cancelled]');
            });

            channel.on('data', (chunk: Buffer) => stdoutChunks.push(chunk.toString('utf-8')));
            channel.stderr!.on('data', (chunk: Buffer) => stderrChunks.push(chunk.toString('utf-8')));
            channel.on('close', (code: number) => {
                const stdout = stdoutChunks.join('');
                const stderr = stderrChunks.join('').trim();

                if (stderr) {
                    // MySQL errors — check if credentials are wrong
                    if (stderr.includes('Access denied') || stderr.includes('ERROR 1045')) {
                        // Clear cached credentials so discovery runs again next time
                        mysqlCredentialsCache.delete(connName);
                        finish(
                            `MySQL access denied (host: ${creds.host}, user: ${creds.user}, db: ${database || 'none'}).\n` +
                            `Credentials were auto-discovered from: ${creds.source}\n\n` +
                            `The cached credentials have been cleared. Please provide correct credentials ` +
                            `by calling this tool with host, user, password, and database parameters, ` +
                            `or ask the user for the correct database credentials.`
                        );
                        return;
                    }
                    if (!stdout) {
                        finish(`MySQL error (exit code ${code}):\n${stderr}`);
                        return;
                    }
                    // Has both stdout and stderr — include both
                }

                if (!stdout && !stderr) {
                    if (isReadOnlySQL(query)) {
                        finish('(query returned no results)');
                    } else {
                        finish(`Query executed successfully (exit code: ${code}).`);
                    }
                    return;
                }

                // Format the output
                let result = '';
                if (stdout) {
                    result = formatMySQLOutput(stdout);
                }
                if (stderr) {
                    result += (result ? '\n\n--- warnings ---\n' : '') + stderr;
                }

                // Truncate very large outputs
                const MAX_OUTPUT = 50_000;
                if (result.length > MAX_OUTPUT) {
                    result = result.substring(0, MAX_OUTPUT) + `\n... [truncated at ${MAX_OUTPUT} chars]`;
                }

                // Add row count info for SELECT queries
                if (isReadOnlySQL(query)) {
                    const dataRows = stdout.split('\n').filter(l => l.length > 0).length - 1; // minus header
                    if (dataRows >= 0) {
                        result += `\n\n(${dataRows} row${dataRows !== 1 ? 's' : ''})`;
                    }
                }

                finish(result);
            });
        });

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(output)
        ]);
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<SSHMySQLQueryInput>,
        token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const { query, connectionName } = options.input;
        const conn = this.getConnection(connectionName);
        const connName = conn.config.name;
        const root = conn.config.root || '/';
        const readOnly = isReadOnlySQL(query);
        const confirmWrites = conn.config.mysqlConfirmWrites !== false; // default true

        // Check if this is the first call (no cached credentials and no explicit ones)
        const hasExplicit = !!(options.input.host || options.input.user || options.input.password || options.input.database);
        const hasCached = mysqlCredentialsCache.has(connName);

        if (!hasExplicit && !hasCached) {
            // First call — discover credentials and show them for confirmation
            const discovered = await discoverMySQLCredentials(conn.client, root, token);
            if (discovered) {
                // Cache them so invoke() can use them
                mysqlCredentialsCache.set(connName, discovered);

                return {
                    invocationMessage: `MySQL query on ${connName} (db: ${discovered.database})`,
                    confirmationMessages: {
                        title: 'MySQL — Confirm Credentials',
                        message: new vscode.MarkdownString(
                            `Found MySQL credentials in **${discovered.source}**:\n\n` +
                            `| Setting | Value |\n|---|---|\n` +
                            `| Host | \`${discovered.host}\` |\n` +
                            `| User | \`${discovered.user}\` |\n` +
                            `| Database | \`${discovered.database}\` |\n` +
                            `| Password | \`${'*'.repeat(Math.min(discovered.password.length, 8)) || '(empty)'}\` |\n\n` +
                            `**Query:**\n\`\`\`sql\n${query}\n\`\`\`\n\n` +
                            `Use these credentials? If not, click **Cancel** and provide different credentials in the chat.`
                        ),
                    },
                };
            }
            // No credentials found — let invoke() handle the error message
            return {
                invocationMessage: `MySQL query on ${connName} (no credentials found)`,
            };
        }

        // Subsequent calls — credentials are available
        const creds = hasExplicit
            ? { database: options.input.database || mysqlCredentialsCache.get(connName)?.database || '?' }
            : mysqlCredentialsCache.get(connName)!;
        const dbLabel = options.input.database || creds.database || '?';

        // Write queries with confirmation enabled
        if (!readOnly && confirmWrites) {
            return {
                invocationMessage: `MySQL write query on ${connName} (db: ${dbLabel})`,
                confirmationMessages: {
                    title: 'MySQL — Confirm Write Query',
                    message: new vscode.MarkdownString(
                        `Execute on **${connName}** (database: \`${dbLabel}\`)?\n\n` +
                        `\`\`\`sql\n${query}\n\`\`\`\n\n` +
                        `⚠️ This is a **write operation** that will modify data.`
                    ),
                },
            };
        }

        // Read queries or writes without confirmation
        return {
            invocationMessage: `MySQL ${readOnly ? 'query' : 'write'} on ${connName} (db: ${dbLabel}): ${query.substring(0, 80)}${query.length > 80 ? '...' : ''}`,
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
        subscribe(vscode.lm.registerTool('sshfs_read_file', new SSHReadFileTool(connectionManager)));
        Logging.info`Registered Language Model Tool: sshfs_read_file — Copilot file reading via 'sed'`;
    } catch (e) {
        Logging.warning`Failed to register sshfs_read_file: ${e}`;
    }

    try {
        subscribe(vscode.lm.registerTool('sshfs_edit_file', new SSHEditFileTool(connectionManager)));
        Logging.info`Registered Language Model Tool: sshfs_edit_file — Copilot file editing via SFTP`;
    } catch (e) {
        Logging.warning`Failed to register sshfs_edit_file: ${e}`;
    }

    try {
        subscribe(vscode.lm.registerTool('sshfs_create_file', new SSHCreateFileTool(connectionManager)));
        Logging.info`Registered Language Model Tool: sshfs_create_file — Copilot file creation via SFTP`;
    } catch (e) {
        Logging.warning`Failed to register sshfs_create_file: ${e}`;
    }

    try {
        subscribe(vscode.lm.registerTool('sshfs_search_text', new SSHSearchTextTool(connectionManager)));
        Logging.info`Registered Language Model Tool: sshfs_search_text — Copilot text search via 'grep'`;
    } catch (e) {
        Logging.warning`Failed to register sshfs_search_text: ${e}`;
    }

    try {
        subscribe(vscode.lm.registerTool('sshfs_mysql_query', new SSHMySQLQueryTool(connectionManager)));
        Logging.info`Registered Language Model Tool: sshfs_mysql_query — Copilot MySQL queries via SSH`;
    } catch (e) {
        Logging.warning`Failed to register sshfs_mysql_query: ${e}`;
    }
}
