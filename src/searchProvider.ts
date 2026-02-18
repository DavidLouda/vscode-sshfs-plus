import type { Client, ClientChannel } from 'ssh2';
import * as vscode from 'vscode';
import type { ConnectionManager } from './connection';
import { Logging } from './logging';
import { toPromise } from './utils';

/*
 * WorkspaceSymbolProvider runs `grep` on the remote server to find symbol definitions.
 * This enables fast "Go to Symbol in Workspace" (Ctrl+T) for SSH workspaces.
 *
 * File search and text search for Copilot agent mode are now handled by
 * dedicated Language Model Tools (sshfs_find_files, sshfs_search_text)
 * in chatTools.ts — these use stable APIs and work for all users.
 */

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
            // Return partial output if available
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

/**
 * Escapes a string for use in a shell command (wraps in single quotes).
 */
function shellEscape(str: string): string {
    return "'" + str.replace(/'/g, "'\\''") + "'";
}

/**
 * Detects the SymbolKind from a source code line containing a definition keyword.
 */
function detectSymbolKind(line: string): vscode.SymbolKind {
    // CSS selectors
    if (/^\s*\./.test(line)) return vscode.SymbolKind.Class;       // .class-name
    if (/^\s*#/.test(line)) return vscode.SymbolKind.Field;        // #id-name
    if (/^\s*@(media|keyframes|font-face|supports|layer)/.test(line)) return vscode.SymbolKind.Namespace;
    if (/^\s*@mixin\b/.test(line)) return vscode.SymbolKind.Function;
    if (/^\s*\$/.test(line)) return vscode.SymbolKind.Variable;    // SCSS $variable
    if (/^\s*--/.test(line)) return vscode.SymbolKind.Property;    // CSS custom property
    // Code constructs
    if (/\b(class|struct|impl)\b/i.test(line)) return vscode.SymbolKind.Class;
    if (/\b(interface|trait|protocol)\b/i.test(line)) return vscode.SymbolKind.Interface;
    if (/\b(function|def|func|fn)\b/i.test(line)) return vscode.SymbolKind.Function;
    if (/\benum\b/i.test(line)) return vscode.SymbolKind.Enum;
    if (/\b(module|namespace|package)\b/i.test(line)) return vscode.SymbolKind.Module;
    if (/\b(type|typedef|newtype|typealias)\b/i.test(line)) return vscode.SymbolKind.TypeParameter;
    if (/\bconst\b/i.test(line)) return vscode.SymbolKind.Constant;
    if (/\b(let|var)\b/i.test(line)) return vscode.SymbolKind.Variable;
    return vscode.SymbolKind.Variable;
}

/**
 * WorkspaceSymbolProvider — runs `grep` on the remote server to find symbol definitions.
 * This enables fast "Go to Symbol in Workspace" (Ctrl+T) for SSH workspaces,
 * and provides Copilot with symbol-level understanding of the remote codebase.
 *
 * Instead of VS Code parsing every file via SFTP, we run a single `grep -rn` on
 * the server to find function/class/interface/... definitions matching the query.
 */
export class SSHWorkspaceSymbolProvider implements vscode.WorkspaceSymbolProvider {
    constructor(private readonly connectionManager: ConnectionManager) {}

    async provideWorkspaceSymbols(
        query: string,
        token: vscode.CancellationToken
    ): Promise<vscode.SymbolInformation[]> {
        if (!query || query.length < 2) return [];

        const folders = vscode.workspace.workspaceFolders?.filter(f => f.uri.scheme === 'ssh') || [];
        if (folders.length === 0) return [];

        // Run searches in parallel across all SSH folders
        const promises = folders.map(folder => this.searchFolder(folder, query, token));
        const allResults = await Promise.all(promises);
        return allResults.flat();
    }

    private async searchFolder(
        folder: vscode.WorkspaceFolder,
        query: string,
        token: vscode.CancellationToken
    ): Promise<vscode.SymbolInformation[]> {
        if (token.isCancellationRequested) return [];

        const conn = this.connectionManager.getActiveConnection(folder.uri.authority);
        if (!conn) return [];

        const results: vscode.SymbolInformation[] = [];
        const basePath = folder.uri.path || '/';

        // Escape query for use in grep extended regex
        const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        // Grep pattern: code definition keyword followed by an identifier containing the query
        const codeKeywords = 'function|class|interface|type|enum|const|let|var|def|module|namespace|struct|trait|impl';
        // CSS/SCSS patterns: .class-name, #id-name, @mixin, @keyframes, $variable, --custom-prop
        // Note: [$] is used instead of \$ for literal dollar sign in ERE
        const cssPatterns = `[.#][a-zA-Z_-]*${escapedQuery}[a-zA-Z0-9_-]*|@(mixin|keyframes)[[:space:]]+[a-zA-Z_-]*${escapedQuery}|[$][a-zA-Z_-]*${escapedQuery}[a-zA-Z0-9_-]*[[:space:]]*:|--[a-zA-Z_-]*${escapedQuery}[a-zA-Z0-9_-]*[[:space:]]*:`;
        const pattern = `(${codeKeywords})[[:space:]]+[a-zA-Z0-9_]*${escapedQuery}|${cssPatterns}`;

        // Include common source file extensions (code + styles + templates)
        const sourceIncludes = [
            // JavaScript / TypeScript
            '*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', '*.cjs',
            // CSS / preprocessors
            '*.css', '*.scss', '*.sass', '*.less', '*.styl',
            // PHP / templates
            '*.php', '*.phtml', '*.twig', '*.blade.php',
            // HTML / markup
            '*.html', '*.htm', '*.xml', '*.svg',
            // Python / Ruby / JVM
            '*.py', '*.rb', '*.java', '*.kt', '*.scala', '*.go',
            // Systems / native
            '*.rs', '*.c', '*.cpp', '*.h', '*.hpp', '*.cc', '*.cs',
            // Others
            '*.swift', '*.dart', '*.lua', '*.vue', '*.svelte', '*.astro',
        ].map(p => `--include=${shellEscape(p)}`).join(' ');

        const excludeDirs = [
            'node_modules', '.git', '.yarn', '__pycache__', '.cache',
            'dist', 'build', '.next', 'target', '.venv', 'vendor',
        ].map(d => `--exclude-dir=${shellEscape(d)}`).join(' ');

        const cmd = `grep -rn -iE ${shellEscape(pattern)} ${sourceIncludes} ${excludeDirs} ${shellEscape(basePath)} 2>/dev/null | head -n 300`;

        Logging.debug`WorkspaceSymbol: ${cmd}`;
        const output = await execCommand(conn.client, cmd, token, 10_000);
        if (!output || token.isCancellationRequested) return [];

        const lineRegex = /^(.+?):(\d+):(.*)$/;
        const codeNameRegex = /\b(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|const|let|var|def|module|namespace|struct|trait|impl)\s+(\w+)/i;
        // CSS: .class-name anywhere on line (not just start), #id-name, @mixin, @keyframes, $var, --prop
        const cssClassRegex = /\.([a-zA-Z_][a-zA-Z0-9_-]*)(?:\s*[{,:]|\s*$)/;
        const cssIdRegex = /#([a-zA-Z_][a-zA-Z0-9_-]*)(?:\s*[{,:]|\s*$)/;
        const cssMixinRegex = /@(mixin|keyframes)\s+([a-zA-Z_][a-zA-Z0-9_-]*)/;
        const scssVarRegex = /\$([a-zA-Z_][a-zA-Z0-9_-]*)\s*:/;
        const cssCustomPropRegex = /(--[a-zA-Z_][a-zA-Z0-9_-]*)\s*:/;

        for (const line of output.split('\n')) {
            const match = lineRegex.exec(line.trim());
            if (!match) continue;

            const [, filePath, lineNumStr, content] = match;
            const lineNum = parseInt(lineNumStr, 10) - 1;

            let symbolName: string | undefined;
            let kind: vscode.SymbolKind;

            // Try CSS patterns first (for .css/.scss/.less files or inline styles)
            const cssClass = cssClassRegex.exec(content);
            const cssId = cssIdRegex.exec(content);
            const cssMixin = cssMixinRegex.exec(content);
            const scssVar = scssVarRegex.exec(content);
            const cssProp = cssCustomPropRegex.exec(content);

            if (cssClass) {
                symbolName = '.' + cssClass[1];
                kind = vscode.SymbolKind.Class;
            } else if (cssId) {
                symbolName = '#' + cssId[1];
                kind = vscode.SymbolKind.Field;
            } else if (cssMixin) {
                symbolName = cssMixin[2];
                kind = cssMixin[1] === 'keyframes' ? vscode.SymbolKind.Namespace : vscode.SymbolKind.Function;
            } else if (scssVar) {
                symbolName = '$' + scssVar[1];
                kind = vscode.SymbolKind.Variable;
            } else if (cssProp) {
                symbolName = cssProp[1];
                kind = vscode.SymbolKind.Property;
            } else {
                // Code pattern (JS/TS/PHP/Python/etc.)
                const symbolMatch = codeNameRegex.exec(content);
                if (!symbolMatch) continue;
                symbolName = symbolMatch[1];
                kind = detectSymbolKind(content);
            }

            results.push(new vscode.SymbolInformation(
                symbolName,
                kind,
                folder.name,
                new vscode.Location(
                    folder.uri.with({ path: filePath }),
                    new vscode.Position(lineNum, 0)
                )
            ));
        }

        return results;
    }
}

/**
 * Registers WorkspaceSymbolProvider for the 'ssh' scheme.
 * File search and text search are provided via Language Model Tools
 * (sshfs_find_files, sshfs_search_text) in chatTools.ts.
 */
export function registerSearchProviders(
    connectionManager: ConnectionManager,
    subscribe: (...disposables: vscode.Disposable[]) => void
): void {
    try {
        const symbolProvider = new SSHWorkspaceSymbolProvider(connectionManager);
        subscribe(vscode.languages.registerWorkspaceSymbolProvider(symbolProvider));
        Logging.info`Registered WorkspaceSymbolProvider — remote symbol search via 'grep'`;
    } catch (e) {
        Logging.warning`Failed to register WorkspaceSymbolProvider: ${e}`;
    }
}
