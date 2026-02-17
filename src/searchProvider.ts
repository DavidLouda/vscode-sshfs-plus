import type { Client, ClientChannel } from 'ssh2';
import * as vscode from 'vscode';
import type { ConnectionManager } from './connection';
import { Logging } from './logging';
import { toPromise } from './utils';

/*
 * FileSearchProvider & TextSearchProvider are proposed APIs in VS Code.
 * They exist at runtime (vscode.workspace.registerFileSearchProvider / registerTextSearchProvider)
 * but are not included in the stable @types/vscode typings.
 *
 * We use `any` casts and runtime detection to register them when available.
 * This enables dramatically faster file/text search for SSH workspaces —
 * instead of VS Code walking the entire directory tree via SFTP (hundreds of round-trips),
 * we run `find` and `grep` directly on the remote server.
 *
 * This is critical for Copilot Agent performance, which relies heavily on
 * grep_search and file_search to understand the codebase.
 */

/**
 * Executes a command on the SSH server and returns stdout.
 * Returns null if the command fails or produces no output.
 */
async function execCommand(client: Client, command: string, token?: vscode.CancellationToken): Promise<string | null> {
    const channel = await toPromise<ClientChannel>(cb => client.exec(command, cb));
    return new Promise<string | null>((resolve) => {
        const chunks: string[] = [];
        const dispose = token?.onCancellationRequested(() => {
            channel.close();
            resolve(null);
        });
        channel.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf-8')));
        channel.on('close', () => {
            dispose?.dispose();
            const output = chunks.join('');
            resolve(output || null);
        });
        channel.stderr!.on('data', () => { /* ignore stderr */ });
    });
}

/**
 * Escapes a string for use in a shell command (wraps in single quotes).
 */
function shellEscape(str: string): string {
    return "'" + str.replace(/'/g, "'\\''") + "'";
}

/**
 * FileSearchProvider — runs `find` on the remote server to search for files by name.
 * This replaces VS Code's default behavior of recursively walking the filesystem via SFTP,
 * making file search (Ctrl+P) and Copilot agent file discovery dramatically faster.
 */
export class SSHFileSearchProvider {
    constructor(private readonly connectionManager: ConnectionManager) { }

    async provideFileSearchResults(
        query: { pattern: string },
        options: { folder: vscode.Uri; excludes: string[]; maxResults?: number },
        token: vscode.CancellationToken
    ): Promise<vscode.Uri[]> {
        const authority = options.folder.authority;
        const conn = this.connectionManager.getActiveConnection(authority);
        if (!conn) return [];

        const basePath = options.folder.path || '/';
        const pattern = query.pattern.toLowerCase();

        // Default excludes for common large directories
        const defaultExcludes = ['.git', 'node_modules', '.yarn', '__pycache__', '.cache'];
        const userExcludes = options.excludes || [];
        const allExcludes = [...new Set([...defaultExcludes, ...userExcludes.map(e => e.replace(/^\*\*[/\\]/, ''))])];

        const excludeParts = allExcludes.map(e => `-name ${shellEscape(e)} -prune`).join(' -o ');
        const maxResults = options.maxResults || 5000;

        // Pattern: *p*a*t*t*e*r*n* for fuzzy matching (each char separated by *)
        const fuzzyPattern = '*' + pattern.split('').join('*') + '*';
        const cmd = `find ${shellEscape(basePath)} \\( ${excludeParts} \\) -o -type f -iname ${shellEscape(fuzzyPattern)} -print 2>/dev/null | head -n ${maxResults}`;

        Logging.debug`FileSearch: ${cmd}`;
        const output = await execCommand(conn.client, cmd, token);
        if (!output || token.isCancellationRequested) return [];

        const results: vscode.Uri[] = [];
        for (const line of output.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            results.push(options.folder.with({ path: trimmed }));
        }

        Logging.debug`FileSearch: found ${results.length} results for "${query.pattern}"`;
        return results;
    }
}

/** Query shape for TextSearchProvider (mirrors proposed vscode.TextSearchQuery) */
interface TextQuery {
    pattern: string;
    isCaseSensitive?: boolean;
    isWordMatch?: boolean;
    isRegExp?: boolean;
}

/**
 * TextSearchProvider — runs `grep` on the remote server to search for text in files.
 * This replaces VS Code's default behavior of downloading and scanning every file via SFTP,
 * making text search (Ctrl+Shift+F) and Copilot agent grep operations dramatically faster.
 */
export class SSHTextSearchProvider {
    constructor(private readonly connectionManager: ConnectionManager) { }

    async provideTextSearchResults(
        query: TextQuery,
        options: { folder: vscode.Uri; includes: string[]; excludes: string[]; maxResults?: number },
        progress: vscode.Progress<any>,
        token: vscode.CancellationToken
    ): Promise<{ limitHit: boolean }> {
        const authority = options.folder.authority;
        const conn = this.connectionManager.getActiveConnection(authority);
        if (!conn) return { limitHit: false };

        const basePath = options.folder.path || '/';
        const maxResults = options.maxResults || 2000;

        // Build grep command
        const grepFlags: string[] = ['-r', '-n', '--color=never'];

        if (!query.isCaseSensitive) grepFlags.push('-i');
        if (query.isWordMatch) grepFlags.push('-w');
        if (query.isRegExp) {
            grepFlags.push('-E');
        } else {
            grepFlags.push('-F');
        }

        // Include patterns
        if (options.includes && options.includes.length > 0) {
            for (const inc of options.includes) {
                const includePattern = inc.replace(/^\*\*[/\\]/, '');
                grepFlags.push(`--include=${shellEscape(includePattern)}`);
            }
        }

        // Exclude patterns
        const defaultExcludes = ['.git', 'node_modules', '.yarn', '__pycache__', '.cache'];
        const userExcludes = options.excludes || [];
        const allExcludes = [...new Set([...defaultExcludes, ...userExcludes.map(e => e.replace(/^\*\*[/\\]/, ''))])];
        for (const exc of allExcludes) {
            if (exc.includes('.')) {
                grepFlags.push(`--exclude=${shellEscape(exc)}`);
            } else {
                grepFlags.push(`--exclude-dir=${shellEscape(exc)}`);
            }
        }

        grepFlags.push('--binary-files=without-match');

        const cmd = `grep ${grepFlags.join(' ')} -- ${shellEscape(query.pattern)} ${shellEscape(basePath)} 2>/dev/null | head -n ${maxResults}`;

        Logging.debug`TextSearch: ${cmd}`;
        const output = await execCommand(conn.client, cmd, token);

        if (!output || token.isCancellationRequested) {
            return { limitHit: false };
        }

        const lines = output.split('\n');
        let resultCount = 0;

        // Parse grep output: filepath:linenum:content
        const grepLineRegex = /^(.+?):(\d+):(.*)$/;
        for (const line of lines) {
            if (token.isCancellationRequested) break;

            const match = grepLineRegex.exec(line);
            if (!match) continue;

            const [, filePath, lineNumStr, lineText] = match;
            const lineNum = parseInt(lineNumStr, 10) - 1; // VS Code uses 0-based lines

            // Find match positions in line text
            const matchRanges = findMatchRanges(lineText, query);
            if (matchRanges.length === 0) continue;

            for (const r of matchRanges) {
                progress.report({
                    uri: options.folder.with({ path: filePath }),
                    ranges: [new vscode.Range(lineNum, r.start, lineNum, r.end)],
                    preview: {
                        text: lineText,
                        matches: [new vscode.Range(0, r.start, 0, r.end)],
                    },
                });
                resultCount++;
            }

            if (resultCount >= maxResults) {
                return { limitHit: true };
            }
        }

        Logging.debug`TextSearch: ${resultCount} matches for "${query.pattern}"`;
        return { limitHit: lines.length >= maxResults };
    }
}

/**
 * Find all match ranges (as {start, end} character offsets) in a line of text.
 */
function findMatchRanges(lineText: string, query: TextQuery): { start: number; end: number }[] {
    const ranges: { start: number; end: number }[] = [];
    try {
        let pattern: string;
        let flags = 'g';
        if (!query.isCaseSensitive) flags += 'i';

        if (query.isRegExp) {
            pattern = query.pattern;
        } else {
            pattern = query.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }

        if (query.isWordMatch) {
            pattern = `\\b${pattern}\\b`;
        }

        const regex = new RegExp(pattern, flags);
        let m: RegExpExecArray | null;
        while ((m = regex.exec(lineText)) !== null) {
            ranges.push({ start: m.index, end: m.index + m[0].length });
            if (m[0].length === 0) break; // prevent infinite loop on zero-width matches
        }
    } catch {
        // If regex fails, try simple string indexOf
        const searchStr = query.isCaseSensitive ? query.pattern : query.pattern.toLowerCase();
        const searchIn = query.isCaseSensitive ? lineText : lineText.toLowerCase();
        let idx = 0;
        while ((idx = searchIn.indexOf(searchStr, idx)) !== -1) {
            ranges.push({ start: idx, end: idx + searchStr.length });
            idx += searchStr.length || 1;
        }
    }
    return ranges;
}

/**
 * Registers FileSearchProvider and TextSearchProvider for the 'ssh' scheme.
 * These are proposed VS Code APIs — available at runtime but not in @types/vscode.
 * If the APIs are unavailable, registration is silently skipped.
 */
export function registerSearchProviders(
    connectionManager: ConnectionManager,
    subscribe: (...disposables: vscode.Disposable[]) => void
): void {
    const ws = vscode.workspace as any;

    if (typeof ws.registerFileSearchProvider === 'function') {
        try {
            const provider = new SSHFileSearchProvider(connectionManager);
            subscribe(ws.registerFileSearchProvider('ssh', provider));
            Logging.info`Registered FileSearchProvider for ssh:// — remote file search via 'find'`;
        } catch (e) {
            Logging.warning`Failed to register FileSearchProvider: ${e}`;
        }
    } else {
        Logging.debug`FileSearchProvider API not available (proposed API)`;
    }

    if (typeof ws.registerTextSearchProvider === 'function') {
        try {
            const provider = new SSHTextSearchProvider(connectionManager);
            subscribe(ws.registerTextSearchProvider('ssh', provider));
            Logging.info`Registered TextSearchProvider for ssh:// — remote text search via 'grep'`;
        } catch (e) {
            Logging.warning`Failed to register TextSearchProvider: ${e}`;
        }
    } else {
        Logging.debug`TextSearchProvider API not available (proposed API)`;
    }
}
