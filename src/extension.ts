import type { FileSystemConfig } from 'common/fileSystemConfig';
import { invalidConfigName } from 'common/fileSystemConfig';
import * as os from 'os';
import * as vscode from 'vscode';
import { getConfigs, loadConfigs, reloadWorkspaceFolderConfigs, updateConfig } from './config';
import type { Connection } from './connection';
import { FileSystemRouter } from './fileSystemRouter';
import { Logging, setDebug } from './logging';
import { Manager } from './manager';
import { registerChatTools } from './chatTools';
import { registerChatParticipant } from './chatParticipant';
import { createQuickDiffManager, getQuickDiffManager } from './quickDiff';
import { registerSearchProviders } from './searchProvider';
import type { SSHPseudoTerminal } from './pseudoTerminal';
import { ConfigTreeProvider, ConnectionTreeProvider } from './treeViewManager';
import { PickComplexOptions, pickComplex, pickConnection, setGetExtensionUri, setupWhenClauseContexts } from './ui-utils';

interface CommandHandler {
  /** If set, a string/undefined prompts using the given options.
   * If the input was a string, promptOptions.nameFilter is set to it */
  promptOptions: PickComplexOptions;
  handleString?(string: string): void;
  handleUri?(uri: vscode.Uri): void;
  handleConfig?(config: FileSystemConfig): void;
  handleConnection?(connection: Connection): void;
  handleTerminal?(terminal: SSHPseudoTerminal): void;
}

/** `findConfigs` in config.ts ignores URIs for still-connecting connections */
export let MANAGER: Manager | undefined;

/**
 * Parse an OpenSSH config file and return an array of host entries.
 * Supports: Host, HostName, User, Port, IdentityFile, ProxyJump (→ hop).
 */
function parseSSHConfigFile(content: string): { host: string; hostname?: string; user?: string; port?: number; identityFile?: string; hop?: string }[] {
  const entries: { host: string; hostname?: string; user?: string; port?: number; identityFile?: string; hop?: string }[] = [];
  let current: typeof entries[0] | null = null;

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const match = line.match(/^(\w+)\s+(.+)$/);
    if (!match) continue;
    const [, key, value] = match;

    switch (key.toLowerCase()) {
      case 'host':
        // Skip wildcard hosts
        if (value.includes('*') || value.includes('?')) {
          current = null;
          continue;
        }
        current = { host: value.split(/\s+/)[0] };
        entries.push(current);
        break;
      case 'hostname':
        if (current) current.hostname = value;
        break;
      case 'user':
        if (current) current.user = value;
        break;
      case 'port':
        if (current) {
          const p = parseInt(value, 10);
          if (p > 0 && p <= 65535) current.port = p;
        }
        break;
      case 'identityfile':
        if (current) current.identityFile = value.replace(/^~/, os.homedir());
        break;
      case 'proxyjump':
        if (current) current.hop = value;
        break;
    }
  }
  return entries;
}

/**
 * Import SSH hosts from ~/.ssh/config into SSH FS Plus global settings.
 * Shows a QuickPick for the user to select which hosts to import.
 */
async function importSSHConfig(): Promise<void> {
  const sshConfigPath = vscode.Uri.file(os.homedir() + '/.ssh/config');
  let content: string;
  try {
    const raw = await vscode.workspace.fs.readFile(sshConfigPath);
    content = Buffer.from(raw).toString('utf-8');
  } catch {
    vscode.window.showErrorMessage('Could not read ~/.ssh/config. Make sure the file exists.');
    return;
  }

  const entries = parseSSHConfigFile(content);
  if (entries.length === 0) {
    vscode.window.showInformationMessage('No hosts found in ~/.ssh/config (wildcard hosts are skipped).');
    return;
  }

  // Filter out hosts that already exist in our config
  const existing = getConfigs().map(c => c.name.toLowerCase());
  const newEntries = entries.filter(e => !existing.includes(e.host.toLowerCase()));

  if (newEntries.length === 0) {
    vscode.window.showInformationMessage('All hosts from ~/.ssh/config are already imported.');
    return;
  }

  // QuickPick for selection
  const items = newEntries.map(e => ({
    label: e.host,
    description: `${e.user ? e.user + '@' : ''}${e.hostname || e.host}${e.port && e.port !== 22 ? ':' + e.port : ''}`,
    detail: [
      e.identityFile ? `Key: ${e.identityFile}` : '',
      e.hop ? `ProxyJump: ${e.hop}` : '',
    ].filter(Boolean).join('  ') || undefined,
    entry: e,
    picked: true,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    placeHolder: 'Select SSH hosts to import',
    title: 'Import from ~/.ssh/config',
  });

  if (!selected || selected.length === 0) return;

  let imported = 0;
  for (const { entry } of selected) {
    const name = entry.host.toLowerCase().replace(/[^a-z0-9_.\-+@/]/g, '-');
    if (invalidConfigName(name)) {
      Logging.warning`Skipping SSH config host '${entry.host}': invalid name after sanitization`;
      continue;
    }

    const config: FileSystemConfig = {
      name,
      label: entry.host,
      host: entry.hostname || entry.host,
      username: entry.user,
      port: entry.port,
      privateKeyPath: entry.identityFile,
      hop: entry.hop,
      _location: 1, // Global settings
      _locations: [1],
    };

    try {
      await updateConfig(config);
      imported++;
    } catch (e) {
      Logging.error`Failed to import SSH host '${entry.host}': ${e}`;
    }
  }

  if (imported > 0) {
    await loadConfigs();
    vscode.window.showInformationMessage(`Successfully imported ${imported} SSH host(s) from ~/.ssh/config.`);
  }
}

export function activate(context: vscode.ExtensionContext) {
  const extension = context.extension;
  const version = extension?.packageJSON?.version;

  Logging.info`Extension activated, version ${version}, mode ${context.extensionMode}`;
  Logging.debug`Running VS Code version ${vscode.version} ${process.versions}`;

  setDebug(process.env.VSCODE_SSHFS_DEBUG?.toLowerCase() === 'true');

  const versionHistory = context.globalState.get<[string, number, number][]>('versionHistory', []);
  const lastVersion = versionHistory[versionHistory.length - 1];
  if (!lastVersion) {
    const classicLastVersion = context.globalState.get<string>('lastVersion');
    if (classicLastVersion) {
      Logging.debug`Previously used ${classicLastVersion}, switching over to new version history`;
      versionHistory.push([classicLastVersion, Date.now(), Date.now()]);
    } else {
      Logging.debug`No previous version detected. Fresh or pre-v1.21.0 installation?`;
    }
    versionHistory.push([version, Date.now(), Date.now()]);
  } else if (lastVersion[0] !== version) {
    Logging.debug`Previously used ${lastVersion[0]}, currently first launch since switching to ${version}`;
    versionHistory.push([version, Date.now(), Date.now()]);
  } else {
    lastVersion[2] = Date.now();
  }
  Logging.info`Version history: ${versionHistory.map(v => v.join(':')).join(' > ')}`;
  context.globalState.update('versionHistory', versionHistory);

  // Really too bad we *need* the ExtensionContext for relative resources
  // I really don't like having to pass context to *everything*, so let's do it this way
  setGetExtensionUri(path => vscode.Uri.joinPath(context.extensionUri, path));

  const manager = MANAGER = new Manager(context);

  const subscribe = context.subscriptions.push.bind(context.subscriptions) as typeof context.subscriptions.push;
  const registerCommand = (command: string, callback: (...args: any[]) => any, thisArg?: any) =>
    subscribe(vscode.commands.registerCommand(command, callback, thisArg));

  subscribe(vscode.workspace.registerFileSystemProvider('ssh', new FileSystemRouter(manager), { isCaseSensitive: true }));
  subscribe(createQuickDiffManager());
  registerSearchProviders(manager.connectionManager, subscribe);
  registerChatTools(manager.connectionManager, subscribe);
  registerChatParticipant(manager.connectionManager, context);
  subscribe(vscode.window.createTreeView('sshfs-configs', { treeDataProvider: new ConfigTreeProvider(), showCollapseAll: true }));
  const connectionTreeProvider = new ConnectionTreeProvider(manager.connectionManager);
  subscribe(vscode.window.createTreeView('sshfs-connections', { treeDataProvider: connectionTreeProvider, showCollapseAll: true }));
  subscribe(vscode.tasks.registerTaskProvider('ssh-shell', manager));
  subscribe(vscode.window.registerTerminalLinkProvider(manager));

  setupWhenClauseContexts(manager.connectionManager);

  function registerCommandHandler(name: string, handler: CommandHandler) {
    const callback = async (arg?: string | FileSystemConfig | Connection | SSHPseudoTerminal | vscode.Uri) => {
      if (handler.promptOptions && (!arg || typeof arg === 'string')) {
        arg = await pickComplex(manager, { ...handler.promptOptions, nameFilter: arg });
      }
      if (typeof arg === 'string') return handler.handleString?.(arg);
      if (!arg) return;
      if (arg instanceof vscode.Uri) {
        return handler.handleUri?.(arg);
      } else if ('handleInput' in arg) {
        return handler.handleTerminal?.(arg);
      } else if ('client' in arg) {
        return handler.handleConnection?.(arg);
      } else if ('name' in arg) {
        return handler.handleConfig?.(arg);
      }
      Logging.warning(`CommandHandler for '${name}' could not handle input '${arg}'`);
    };
    registerCommand(name, callback);
  }

  // sshfs.new()
  registerCommand('sshfs.new', () => manager.openSettings({ type: 'newconfig' }));

  // sshfs.add(target?: string | FileSystemConfig)
  registerCommandHandler('sshfs.add', {
    promptOptions: { promptConfigs: true, promptConnections: true, promptInstantConnection: true },
    handleConfig: config => manager.commandConnect(config),
  });

  // sshfs.disconnect(target: string | FileSystemConfig | Connection)
  registerCommandHandler('sshfs.disconnect', {
    promptOptions: { promptConnections: true },
    handleString: name => manager.commandDisconnect(name),
    handleConfig: config => manager.commandDisconnect(config.name),
    handleConnection: con => manager.commandDisconnect(con),
  });

  // sshfs.disconnectAll()
  registerCommand('sshfs.disconnectAll', () => {
    const conns = manager.connectionManager;
    // Does not close pending connections (yet?)
    conns.getActiveConnections().forEach(conn => conns.closeConnection(conn, 'command:disconnectAll'));
  });

  // sshfs.terminal(target?: FileSystemConfig | Connection | vscode.Uri)
  registerCommandHandler('sshfs.terminal', {
    promptOptions: { promptConfigs: true, promptConnections: true, promptInstantConnection: true },
    handleConfig: config => manager.commandTerminal(config),
    handleConnection: con => manager.commandTerminal(con),
    handleUri: async uri => {
      const con = await pickConnection(manager, uri.authority);
      con && manager.commandTerminal(con, uri);
    },
  });

  // sshfs.focusTerminal(target?: SSHPseudoTerminal)
  registerCommandHandler('sshfs.focusTerminal', {
    promptOptions: { promptTerminals: true },
    handleTerminal: ({ terminal }) => terminal?.show(false),
  });

  // sshfs.closeTerminal(target?: SSHPseudoTerminal)
  registerCommandHandler('sshfs.closeTerminal', {
    promptOptions: { promptTerminals: true },
    handleTerminal: terminal => terminal.close(),
  });

  // sshfs.configure(target?: string | FileSystemConfig)
  registerCommandHandler('sshfs.configure', {
    promptOptions: { promptConfigs: true },
    handleConfig: config => manager.commandConfigure(config),
  });

  // sshfs.reload()
  registerCommand('sshfs.reload', loadConfigs);

  // sshfs.settings()
  registerCommand('sshfs.settings', () => manager.openSettings());

  // sshfs.importSSHConfig()
  registerCommand('sshfs.importSSHConfig', () => importSSHConfig());

  // sshfs.refresh()
  registerCommand('sshfs.refresh', () => connectionTreeProvider.refresh());

  // sshfs.resetDiff(target?: vscode.Uri)
  registerCommand('sshfs.resetDiff', (uri?: vscode.Uri) => {
    const qdm = getQuickDiffManager();
    if (!qdm) return;
    if (uri) {
      qdm.resetFileBaseline(uri);
    } else {
      // Reset for current editor's file
      const activeUri = vscode.window.activeTextEditor?.document.uri;
      if (activeUri?.scheme === 'ssh') {
        qdm.resetFileBaseline(activeUri);
      }
    }
  });

  // sshfs.resetAllDiff(target?: string) - reset all baselines for a connection
  registerCommand('sshfs.resetAllDiff', async (name?: string) => {
    const qdm = getQuickDiffManager();
    if (!qdm) return;
    if (!name) {
      const activeUri = vscode.window.activeTextEditor?.document.uri;
      if (activeUri?.scheme === 'ssh') name = activeUri.authority;
    }
    if (name) qdm.resetBaselines(name);
  });

  // sshfs.keepChange(uri, startLine, endLine) - keep a changed block (accept changes)
  registerCommand('sshfs.keepChange', (uri?: vscode.Uri, startLine?: number, endLine?: number) => {
    const qdm = getQuickDiffManager();
    if (!qdm) return;
    if (uri && startLine !== undefined && endLine !== undefined) {
      qdm.keepBlock(uri, startLine, endLine);
    } else {
      // No args — accept all changes for current file (same as resetDiff)
      const activeUri = vscode.window.activeTextEditor?.document.uri;
      if (activeUri?.scheme === 'ssh') qdm.resetFileBaseline(activeUri);
    }
  });

  // sshfs.undoChange(uri, startLine, endLine) - undo a changed block (revert to original)
  registerCommand('sshfs.undoChange', async (uri?: vscode.Uri, startLine?: number, endLine?: number) => {
    const qdm = getQuickDiffManager();
    if (!qdm || !uri || startLine === undefined || endLine === undefined) return;
    await qdm.undoBlock(uri, startLine, endLine);
  });

  // sshfs.acceptChange - accept the change block at cursor position
  registerCommand('sshfs.acceptChange', () => {
    getQuickDiffManager()?.acceptChangeAtCursor();
  });

  // sshfs.rejectChange - reject the change block at cursor position
  registerCommand('sshfs.rejectChange', async () => {
    await getQuickDiffManager()?.rejectChangeAtCursor();
  });

  // sshfs.nextChange - navigate to next changed block
  registerCommand('sshfs.nextChange', () => {
    getQuickDiffManager()?.nextChange();
  });

  // sshfs.prevChange - navigate to previous changed block
  registerCommand('sshfs.prevChange', () => {
    getQuickDiffManager()?.prevChange();
  });

  subscribe(manager.connectionManager.onConnectionAdded(async con => {
    await reloadWorkspaceFolderConfigs(con.actualConfig.name);
  }));

  // Status bar connection indicator
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBarItem.command = 'sshfs.add';
  subscribe(statusBarItem);

  function updateStatusBar() {
    const active = manager.connectionManager.getActiveConnections();
    const pending = manager.connectionManager.getPendingConnections();
    const count = active.length;
    const pendingCount = pending.length;
    if (count === 0 && pendingCount === 0) {
      statusBarItem.text = '$(debug-disconnect) SSH: Disconnected';
      statusBarItem.tooltip = 'No active SSH connections. Click to connect.';
      statusBarItem.backgroundColor = undefined;
    } else if (pendingCount > 0) {
      statusBarItem.text = `$(sync~spin) SSH: ${count} connected, ${pendingCount} connecting...`;
      statusBarItem.tooltip = `${count} active, ${pendingCount} connecting...\nConnections: ${active.map(c => c.actualConfig.label || c.actualConfig.name).join(', ')}`;
      statusBarItem.backgroundColor = undefined;
    } else {
      const names = active.map(c => c.actualConfig.label || c.actualConfig.name).join(', ');
      statusBarItem.text = `$(remote) SSH: ${count} connected`;
      statusBarItem.tooltip = `Active connections: ${names}\nClick to connect another.`;
      statusBarItem.backgroundColor = undefined;
    }
    statusBarItem.show();
  }

  updateStatusBar();
  subscribe(manager.connectionManager.onConnectionAdded(() => updateStatusBar()));
  subscribe(manager.connectionManager.onConnectionRemoved(() => updateStatusBar()));
  subscribe(manager.connectionManager.onPendingChanged(() => updateStatusBar()));
}

export async function deactivate() {
  Logging.info`Extension deactivating, closing all connections...`;
  const conns = MANAGER?.connectionManager;
  if (conns) {
    const closePromises = conns.getActiveConnections().map(conn =>
      new Promise<void>(resolve => {
        conn.client.once('close', () => resolve());
        conns.closeConnection(conn, 'extensionDeactivate');
        setTimeout(resolve, 2000); // don't hang longer than 2s
      })
    );
    await Promise.all(closePromises);
  }
  MANAGER = undefined;
  Logging.info`Extension deactivated`;
}
