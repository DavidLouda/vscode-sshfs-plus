
import * as vscode from 'vscode';
import { Logging } from './logging';

const ORIGINAL_SCHEME = 'ssh-original';

/**
 * Manages QuickDiff (gutter change indicators) for SSH filesystems.
 * 
 * When a file is first read over SSH, its content is cached as the "original" baseline.
 * VS Code then compares the current document content against this baseline and displays
 * colored gutter indicators: green (added), blue (changed), red arrow (deleted).
 * 
 * UX features:
 *  - Line background highlighting for changed lines
 *  - "M" badge in the explorer for modified files
 *  - SCM resource group with click-to-diff
 *  - Editor title bar buttons: Accept All, Next/Previous Change
 *  - Editor context menu: Accept Change, Reject Change (at cursor)
 *  - Status bar indicator showing change count
 *  - Auto-scroll to newly detected changes
 */
export class SSHQuickDiffManager implements vscode.Disposable {
  /** Maps "authority/path" → original file content */
  protected originalContents = new Map<string, Uint8Array>();
  /** Maps authority → SourceControl instance */
  protected sourceControls = new Map<string, vscode.SourceControl>();
  /** Maps authority → SCM resource group for "Changes" */
  protected resourceGroups = new Map<string, vscode.SourceControlResourceGroup>();
  /** Set of file keys (authority/path) that are currently modified */
  protected modifiedFiles = new Set<string>();
  protected disposables: vscode.Disposable[] = [];
  private changedLineDecoration: vscode.TextEditorDecorationType;
  private updateTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Cached changed-line ranges per document (blocks of consecutive changed lines) */
  private cachedChangedRanges = new Map<string, { startLine: number; endLine: number }[]>();
  /** Previous changed-block snapshot, used for auto-scroll (detect new blocks) */
  private previousBlockSnapshot = new Map<string, Set<string>>();

  /** Event emitter for file decoration changes */
  private _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();

  /** Status bar item showing change count */
  private statusBarItem: vscode.StatusBarItem;

  constructor() {
    // Register the TextDocumentContentProvider for the ssh-original scheme
    const contentProvider = new SSHOriginalContentProvider(this.originalContents);
    this.disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(ORIGINAL_SCHEME, contentProvider)
    );

    // Register FileDecorationProvider for "M" badges in the explorer
    const decorationProvider: vscode.FileDecorationProvider = {
      onDidChangeFileDecorations: this._onDidChangeFileDecorations.event,
      provideFileDecoration: (uri: vscode.Uri): vscode.FileDecoration | undefined => {
        if (uri.scheme !== 'ssh') return undefined;
        const key = this.getKey(uri);
        if (!this.modifiedFiles.has(key)) return undefined;
        return new vscode.FileDecoration(
          'M',
          'Modified (SSH)',
          new vscode.ThemeColor('gitDecoration.modifiedResourceForeground')
        );
      }
    };
    this.disposables.push(
      vscode.window.registerFileDecorationProvider(decorationProvider)
    );
    this.disposables.push(this._onDidChangeFileDecorations);

    // Create decoration type for highlighting changed lines with a colored background
    this.changedLineDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
      isWholeLine: true,
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    this.disposables.push(this.changedLineDecoration);

    // Status bar item for showing change count
    this.statusBarItem = vscode.window.createStatusBarItem('sshfs.changeCount', vscode.StatusBarAlignment.Right, 1000);
    this.statusBarItem.name = 'SSH FS Changes';
    this.statusBarItem.command = 'sshfs.nextChange';
    this.statusBarItem.tooltip = 'SSH: Navigate to next change';
    this.disposables.push(this.statusBarItem);

    // Listen for text changes and editor switches to update line decorations + file status
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument(e => {
        this.scheduleUpdateDecorations(e.document);
        this.updateFileModifiedStatus(e.document);
      })
    );
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(e => {
        if (e) this.updateDecorationsForEditor(e);
        this.updateStatusBar();
        this.updateContextKeys();
      })
    );
    this.disposables.push(
      vscode.window.onDidChangeVisibleTextEditors(editors => {
        for (const editor of editors) this.updateDecorationsForEditor(editor);
      })
    );
    // Track cursor position for context key: sshfs:cursorOnChange
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection(e => {
        if (e.textEditor.document.uri.scheme === 'ssh') {
          this.updateContextKeys();
        }
      })
    );

    Logging.info('SSHQuickDiffManager initialized');
  }

  /**
   * Called when an SSHFileSystem is created. Sets up a SourceControl for that authority
   * so VS Code knows to use our QuickDiffProvider for `ssh://authority/...` URIs.
   */
  public registerFileSystem(authority: string): void {
    if (this.sourceControls.has(authority)) return;

    const quickDiffProvider: vscode.QuickDiffProvider = {
      provideOriginalResource: (uri: vscode.Uri): vscode.Uri | undefined => {
        if (uri.scheme !== 'ssh') return undefined;
        const key = this.getKey(uri);
        if (!this.originalContents.has(key)) return undefined;
        // Return the same URI but with our original-content scheme
        return uri.with({ scheme: ORIGINAL_SCHEME });
      }
    };

    const sc = vscode.scm.createSourceControl(
      `sshfs-${authority}`,
      `SSH: ${authority}`,
      vscode.Uri.parse(`ssh://${authority}/`)
    );
    sc.quickDiffProvider = quickDiffProvider;

    // Don't show the input box (we're not a real SCM)
    sc.inputBox.visible = false;

    // Create resource group for showing modified files in Source Control panel
    const changesGroup = sc.createResourceGroup('changes', 'Changes');
    changesGroup.hideWhenEmpty = true;
    this.resourceGroups.set(authority, changesGroup);

    this.sourceControls.set(authority, sc);
    this.disposables.push(sc);
    Logging.debug`QuickDiff registered for ${authority}`;
  }

  /**
   * Called when an SSHFileSystem is closed. Removes the SourceControl and clears the cache
   * for that authority.
   */
  public unregisterFileSystem(authority: string): void {
    const sc = this.sourceControls.get(authority);
    if (sc) {
      sc.dispose();
      this.sourceControls.delete(authority);
    }
    this.resourceGroups.delete(authority);
    // Clear all cached originals and modified status for this authority
    const changedUris: vscode.Uri[] = [];
    for (const key of this.originalContents.keys()) {
      if (key.startsWith(`${authority}/`)) {
        this.originalContents.delete(key);
        if (this.modifiedFiles.delete(key)) {
          changedUris.push(vscode.Uri.parse(`ssh://${key}`));
        }
      }
    }
    if (changedUris.length) this._onDidChangeFileDecorations.fire(changedUris);
    this.refreshDecorations(authority);
    Logging.debug`QuickDiff unregistered for ${authority}`;
  }

  /**
   * Cache the original file content when it's first read.
   * Should be called from SSHFileSystem.readFile() with the result.
   */
  public cacheOriginal(uri: vscode.Uri, content: Uint8Array): void {
    const key = this.getKey(uri);
    if (!this.originalContents.has(key)) {
      this.originalContents.set(key, content);
    }
  }

  /**
   * Update the baseline for a file (e.g., after user explicitly saves or accepts changes).
   */
  public updateBaseline(uri: vscode.Uri, content: Uint8Array): void {
    const key = this.getKey(uri);
    this.originalContents.set(key, content);
  }

  /**
   * Reset the baseline for all files of a given authority to their current content.
   * Called via the "Reset Change Indicators" command.
   */
  public async resetBaselines(authority: string): Promise<void> {
    let count = 0;
    for (const key of this.originalContents.keys()) {
      if (key.startsWith(`${authority}/`)) {
        // Find the matching open document and update baseline to current content
        const uri = vscode.Uri.parse(`ssh://${key}`);
        const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
        if (doc) {
          this.originalContents.set(key, new TextEncoder().encode(doc.getText()));
          count++;
        } else {
          // File not open — just remove from cache so next read sets the new baseline
          this.originalContents.delete(key);
          count++;
        }
      }
    }
    Logging.info`Reset ${count} QuickDiff baselines for ${authority}`;
    // Clear all modified status for this authority
    const changedUris: vscode.Uri[] = [];
    for (const key of this.modifiedFiles) {
      if (key.startsWith(`${authority}/`)) {
        this.modifiedFiles.delete(key);
        changedUris.push(vscode.Uri.parse(`ssh://${key}`));
      }
    }
    this.updateResourceGroup(authority);
    if (changedUris.length) this._onDidChangeFileDecorations.fire(changedUris);
    this.refreshDecorations(authority);
  }

  /**
   * Reset baseline for a single file URI.
   */
  public resetFileBaseline(uri: vscode.Uri): void {
    const key = this.getKey(uri);
    const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
    if (doc) {
      this.originalContents.set(key, new TextEncoder().encode(doc.getText()));
    } else {
      this.originalContents.delete(key);
    }
    this.modifiedFiles.delete(key);
    this.updateResourceGroup(uri.authority);
    this._onDidChangeFileDecorations.fire(uri);
    this.refreshDecorations(uri.authority);
  }

  // --- File modification tracking (explorer badges) ---

  /**
   * Check if a document's current content differs from baseline and update the modified set.
   */
  private updateFileModifiedStatus(document: vscode.TextDocument): void {
    if (document.uri.scheme !== 'ssh') return;
    const key = this.getKey(document.uri);
    const original = this.originalContents.get(key);
    if (!original) return;

    const originalText = new TextDecoder().decode(original);
    const currentText = document.getText();
    const isModified = originalText !== currentText;
    const wasModified = this.modifiedFiles.has(key);

    if (isModified && !wasModified) {
      this.modifiedFiles.add(key);
      this.updateResourceGroup(document.uri.authority);
      this._onDidChangeFileDecorations.fire(document.uri);
    } else if (!isModified && wasModified) {
      this.modifiedFiles.delete(key);
      this.updateResourceGroup(document.uri.authority);
      this._onDidChangeFileDecorations.fire(document.uri);
    }
  }

  /** Update the SCM resource group to reflect currently modified files. */
  private updateResourceGroup(authority: string): void {
    const group = this.resourceGroups.get(authority);
    if (!group) return;
    const resources: vscode.SourceControlResourceState[] = [];
    for (const key of this.modifiedFiles) {
      if (key.startsWith(`${authority}/`)) {
        const uri = vscode.Uri.parse(`ssh://${key}`);
        resources.push({
          resourceUri: uri,
          decorations: {
            strikeThrough: false,
            tooltip: 'Modified',
          },
          command: {
            title: 'Show Changes',
            command: 'vscode.diff',
            arguments: [
              uri.with({ scheme: ORIGINAL_SCHEME }),
              uri,
              `${uri.path.split('/').pop()} (SSH Changes)`
            ]
          }
        });
      }
    }
    group.resourceStates = resources;
  }

  // --- Line highlighting (decorations) ---

  private scheduleUpdateDecorations(document: vscode.TextDocument): void {
    if (document.uri.scheme !== 'ssh') return;
    const key = document.uri.toString();
    const existing = this.updateTimers.get(key);
    if (existing) clearTimeout(existing);
    this.updateTimers.set(key, setTimeout(() => {
      this.updateTimers.delete(key);
      const editor = vscode.window.visibleTextEditors.find(e => e.document === document);
      if (editor) this.updateDecorationsForEditor(editor);
    }, 150));
  }

  private updateDecorationsForEditor(editor: vscode.TextEditor): void {
    const { document } = editor;
    if (document.uri.scheme !== 'ssh') return;
    const key = this.getKey(document.uri);
    const original = this.originalContents.get(key);
    if (!original) {
      editor.setDecorations(this.changedLineDecoration, []);
      return;
    }
    const originalText = new TextDecoder().decode(original);
    const currentText = document.getText();
    const changedLineNumbers = SSHQuickDiffManager.computeChangedLines(originalText, currentText);
    const ranges: vscode.Range[] = changedLineNumbers
      .filter(ln => ln < document.lineCount)
      .map(ln => document.lineAt(ln).range);
    editor.setDecorations(this.changedLineDecoration, ranges);

    // Group consecutive changed lines into blocks
    const blocks: { startLine: number; endLine: number }[] = [];
    if (changedLineNumbers.length > 0) {
      let start = changedLineNumbers[0];
      let end = start;
      for (let i = 1; i < changedLineNumbers.length; i++) {
        if (changedLineNumbers[i] === end + 1) {
          end = changedLineNumbers[i];
        } else {
          blocks.push({ startLine: start, endLine: end });
          start = changedLineNumbers[i];
          end = start;
        }
      }
      blocks.push({ startLine: start, endLine: end });
    }
    const docKey = document.uri.toString();

    // Detect newly appeared blocks for auto-scroll
    const prevSnapshot = this.previousBlockSnapshot.get(docKey);
    const currentSnapshot = new Set(blocks.map(b => `${b.startLine}-${b.endLine}`));
    if (prevSnapshot && blocks.length > 0) {
      // Find the first block that wasn't in the previous snapshot
      for (const block of blocks) {
        const blockKey = `${block.startLine}-${block.endLine}`;
        if (!prevSnapshot.has(blockKey)) {
          // New block detected — auto-scroll to it
          const revealRange = new vscode.Range(block.startLine, 0, Math.min(block.endLine + 1, document.lineCount - 1), 0);
          editor.revealRange(revealRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
          break;
        }
      }
    }
    this.previousBlockSnapshot.set(docKey, currentSnapshot);

    // Update cached blocks
    this.cachedChangedRanges.set(docKey, blocks);

    // Update status bar and context keys
    this.updateStatusBar();
    this.updateContextKeys();
  }

  /** Refresh decorations for all visible editors on a given authority. */
  private refreshDecorations(authority?: string): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.scheme !== 'ssh') continue;
      if (authority && editor.document.uri.authority !== authority) continue;
      this.updateDecorationsForEditor(editor);
    }
    this.updateStatusBar();
    this.updateContextKeys();
  }

  // --- Status bar and context keys ---

  /** Update the status bar item to show the number of changed blocks. */
  private updateStatusBar(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'ssh') {
      this.statusBarItem.hide();
      return;
    }
    const blocks = this.cachedChangedRanges.get(editor.document.uri.toString());
    if (!blocks || blocks.length === 0) {
      this.statusBarItem.hide();
      return;
    }
    const n = blocks.length;
    this.statusBarItem.text = `$(edit) ${n} ${n === 1 ? 'change' : 'changes'}`;
    this.statusBarItem.tooltip = `SSH: ${n} changed ${n === 1 ? 'block' : 'blocks'} — click to jump to next`;
    this.statusBarItem.show();
  }

  /** Update context keys for conditional menu visibility. */
  private updateContextKeys(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'ssh') {
      vscode.commands.executeCommand('setContext', 'sshfs:hasChanges', false);
      vscode.commands.executeCommand('setContext', 'sshfs:cursorOnChange', false);
      return;
    }
    const blocks = this.cachedChangedRanges.get(editor.document.uri.toString());
    const hasChanges = !!blocks && blocks.length > 0;
    vscode.commands.executeCommand('setContext', 'sshfs:hasChanges', hasChanges);

    if (hasChanges && blocks) {
      const cursorLine = editor.selection.active.line;
      const onBlock = blocks.some(b => cursorLine >= b.startLine && cursorLine <= b.endLine);
      vscode.commands.executeCommand('setContext', 'sshfs:cursorOnChange', onBlock);
    } else {
      vscode.commands.executeCommand('setContext', 'sshfs:cursorOnChange', false);
    }
  }

  // --- Change navigation ---

  /** Navigate to the next changed block in the active editor. */
  public nextChange(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'ssh') return;
    const blocks = this.cachedChangedRanges.get(editor.document.uri.toString());
    if (!blocks || blocks.length === 0) return;

    const cursorLine = editor.selection.active.line;
    // Find the first block that starts after the cursor
    const next = blocks.find(b => b.startLine > cursorLine);
    const target = next || blocks[0]; // wrap around to first block
    const range = new vscode.Range(target.startLine, 0, target.endLine + 1, 0);
    editor.selection = new vscode.Selection(target.startLine, 0, target.startLine, 0);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    this.updateContextKeys();
  }

  /** Navigate to the previous changed block in the active editor. */
  public prevChange(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'ssh') return;
    const blocks = this.cachedChangedRanges.get(editor.document.uri.toString());
    if (!blocks || blocks.length === 0) return;

    const cursorLine = editor.selection.active.line;
    // Find the last block that ends before the cursor
    let prev: { startLine: number; endLine: number } | undefined;
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i].endLine < cursorLine) { prev = blocks[i]; break; }
    }
    const target = prev || blocks[blocks.length - 1]; // wrap around to last block
    const range = new vscode.Range(target.startLine, 0, target.endLine + 1, 0);
    editor.selection = new vscode.Selection(target.startLine, 0, target.startLine, 0);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    this.updateContextKeys();
  }

  // --- Accept / Reject at cursor ---

  /** Find the changed block the cursor is currently in. */
  private getBlockAtCursor(): { startLine: number; endLine: number } | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'ssh') return undefined;
    const blocks = this.cachedChangedRanges.get(editor.document.uri.toString());
    if (!blocks) return undefined;
    const cursorLine = editor.selection.active.line;
    return blocks.find(b => cursorLine >= b.startLine && cursorLine <= b.endLine);
  }

  /**
   * Accept the change block at the cursor position — update the baseline for the whole file.
   * (Since individual block acceptance would leave gaps, we accept all changes in the file.)
   */
  public acceptChangeAtCursor(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'ssh') return;
    const block = this.getBlockAtCursor();
    if (!block) return;
    this.keepBlock(editor.document.uri, block.startLine, block.endLine);
  }

  /**
   * Reject the change block at the cursor position — revert that block to original content.
   */
  public async rejectChangeAtCursor(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'ssh') return;
    const block = this.getBlockAtCursor();
    if (!block) return;
    await this.undoBlock(editor.document.uri, block.startLine, block.endLine);
  }

  // --- Keep / Undo per block ---

  /**
   * "Keep" a changed block — update the baseline to the current document content.
   * This removes all change indicators for this file.
   */
  public keepBlock(uri: vscode.Uri, _startLine: number, _endLine: number): void {
    // Update baseline to current content (keeps all changes in this file)
    const key = this.getKey(uri);
    const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
    if (!doc) return;
    this.originalContents.set(key, new TextEncoder().encode(doc.getText()));
    this.modifiedFiles.delete(key);
    this.updateResourceGroup(uri.authority);
    this._onDidChangeFileDecorations.fire(uri);
    this.refreshDecorations(uri.authority);
  }

  /**
   * "Undo" a changed block — revert the document content in startLine..endLine to the original.
   */
  public async undoBlock(uri: vscode.Uri, startLine: number, endLine: number): Promise<void> {
    const key = this.getKey(uri);
    const original = this.originalContents.get(key);
    if (!original) return;
    const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
    if (!doc) return;

    const origText = new TextDecoder().decode(original);
    const currText = doc.getText();
    const origLines = origText.replace(/\r\n/g, '\n').split('\n');
    const currLines = currText.replace(/\r\n/g, '\n').split('\n');

    // Find common prefix/suffix
    const top = SSHQuickDiffManager.commonPrefixLen(origLines, currLines);
    const bottom = SSHQuickDiffManager.commonSuffixLen(origLines, currLines, top);
    const origMiddle = origLines.slice(top, origLines.length - bottom);
    const currMiddle = currLines.slice(top, currLines.length - bottom);

    // Adjust block coordinates to middle coordinates
    const blockStartM = Math.max(0, startLine - top);
    const blockEndM = Math.min(currMiddle.length - 1, endLine - top);
    if (blockStartM > currMiddle.length - 1 || blockEndM < 0) return;

    // Use Myers to find match mapping between orig and curr in the middle region
    const matchMap = SSHQuickDiffManager.buildMatchMap(origMiddle, currMiddle);

    // Find which original lines correspond to the block boundaries
    let origStart = 0;
    let origEnd = origMiddle.length;

    // origStart = first orig line after all matches before the block
    for (const [ci, oi] of matchMap) {
      if (ci < blockStartM) origStart = Math.max(origStart, oi + 1);
    }
    // origEnd = first orig line matched at or after the block end
    for (const [ci, oi] of matchMap) {
      if (ci > blockEndM) { origEnd = Math.min(origEnd, oi); break; }
    }

    const origBlockLines = origMiddle.slice(origStart, origEnd);

    // Build the replacement text
    const replaceStart = new vscode.Position(startLine, 0);
    const replaceEnd = endLine + 1 < currLines.length
      ? new vscode.Position(endLine + 1, 0)
      : new vscode.Position(endLine, currLines[endLine]?.length ?? 0);
    const newText = origBlockLines.join('\n') + (endLine + 1 < currLines.length ? '\n' : '');

    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(replaceStart, replaceEnd), newText);
    await vscode.workspace.applyEdit(edit);
  }

  private static commonPrefixLen(a: string[], b: string[]): number {
    const min = Math.min(a.length, b.length);
    let i = 0;
    while (i < min && a[i] === b[i]) i++;
    return i;
  }

  private static commonSuffixLen(a: string[], b: string[], prefixLen: number): number {
    const min = Math.min(a.length, b.length) - prefixLen;
    let i = 0;
    while (i < min && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
    return i;
  }

  /** Build a sorted Map<currIndex, origIndex> from Myers matched indices. */
  private static buildMatchMap(orig: string[], curr: string[]): Map<number, number> {
    if (orig.length === 0 || curr.length === 0) return new Map();
    const matched = SSHQuickDiffManager.myersMatchedIndices(orig, curr);
    const sorted = [...matched].sort((a, b) => a - b);
    const map = new Map<number, number>();
    let oi = 0;
    for (const ci of sorted) {
      while (oi < orig.length && orig[oi] !== curr[ci]) oi++;
      if (oi < orig.length) {
        map.set(ci, oi);
        oi++;
      }
    }
    return map;
  }

  /**
   * Compute which line numbers (0-based) in currentText differ from originalText.
   * Uses common-prefix/suffix skipping + Myers diff algorithm for accuracy.
   */
  private static computeChangedLines(originalText: string, currentText: string): number[] {
    if (originalText === currentText) return [];
    // Normalize line endings
    const origLines = originalText.replace(/\r\n/g, '\n').split('\n');
    const currLines = currentText.replace(/\r\n/g, '\n').split('\n');
    // Skip common prefix
    let top = 0;
    const minLen = Math.min(origLines.length, currLines.length);
    while (top < minLen && origLines[top] === currLines[top]) top++;
    // Skip common suffix
    let bottom = 0;
    while (bottom < minLen - top &&
      origLines[origLines.length - 1 - bottom] === currLines[currLines.length - 1 - bottom]) {
      bottom++;
    }
    const origMiddle = origLines.slice(top, origLines.length - bottom);
    const currMiddle = currLines.slice(top, currLines.length - bottom);
    if (origMiddle.length === 0) {
      // Pure additions
      return Array.from({ length: currMiddle.length }, (_, i) => top + i);
    }
    if (currMiddle.length === 0) {
      // Pure deletions — nothing to highlight in current
      return [];
    }
    // Use Myers diff to identify precisely which lines changed
    const matched = SSHQuickDiffManager.myersMatchedIndices(origMiddle, currMiddle);
    const changed: number[] = [];
    for (let i = 0; i < currMiddle.length; i++) {
      if (!matched.has(i)) changed.push(top + i);
    }
    return changed;
  }

  /**
   * Myers' diff algorithm — finds which indices in `b` are matched (equal) to lines in `a`.
   * O((N+M)*D) time where D = minimum edit distance.
   * Much faster than O(N*M) LCS for files with few changes.
   * Falls back to position-based comparison if D exceeds threshold.
   */
  private static myersMatchedIndices(a: string[], b: string[]): Set<number> {
    const n = a.length, m = b.length;
    // Limit max edit distance — for normal AI edits D is small (< 100).
    // maxD=500 handles ~250 line replacements or 500 pure insertions.
    const maxD = Math.min(500, n + m);
    const vSize = 2 * maxD + 3;
    const offset = maxD + 1;

    // Forward pass: find shortest edit script
    const v = new Int32Array(vSize);
    v[1 + offset] = 0;
    // Store snapshots of v for backtracking (only the relevant slice)
    const traces: Int32Array[] = [];

    let editDist = -1;
    for (let d = 0; d <= maxD; d++) {
      traces.push(Int32Array.from(v));
      for (let k = -d; k <= d; k += 2) {
        const kOff = k + offset;
        let x: number;
        if (k === -d || (k !== d && v[kOff - 1] < v[kOff + 1])) {
          x = v[kOff + 1]; // insertion (move down)
        } else {
          x = v[kOff - 1] + 1; // deletion (move right)
        }
        let y = x - k;
        // Extend along diagonal (matching lines)
        while (x < n && y < m && a[x] === b[y]) {
          x++; y++;
        }
        v[kOff] = x;
        if (x >= n && y >= m) {
          editDist = d;
          break;
        }
      }
      if (editDist >= 0) break;
    }

    if (editDist < 0) {
      // D exceeded maxD — fall back to position-based matching
      const matched = new Set<number>();
      for (let i = 0; i < Math.min(a.length, b.length); i++) {
        if (a[i] === b[i]) matched.add(i);
      }
      return matched;
    }

    // Backtrack to find which lines in `b` are equal matches
    const matched = new Set<number>();
    let x = n, y = m;
    for (let d = editDist; d > 0; d--) {
      const prev = traces[d]; // v snapshot before round d
      const k = x - y;
      const kOff = k + offset;
      let prevK: number;
      if (k === -d || (k !== d && prev[kOff - 1] < prev[kOff + 1])) {
        prevK = k + 1; // came from insertion
      } else {
        prevK = k - 1; // came from deletion
      }
      const prevX = prev[prevK + offset];
      const prevY = prevX - prevK;
      // Diagonal moves = matched lines
      while (x > prevX && y > prevY) {
        x--; y--;
        matched.add(y);
      }
      x = prevX;
      y = prevY;
    }
    // Remaining diagonal at d=0
    while (x > 0 && y > 0) {
      x--; y--;
      matched.add(y);
    }
    return matched;
  }

  protected getKey(uri: vscode.Uri): string {
    return `${uri.authority}${uri.path}`;
  }

  public dispose(): void {
    for (const timer of this.updateTimers.values()) clearTimeout(timer);
    this.updateTimers.clear();
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
    this.originalContents.clear();
    this.sourceControls.clear();
    this.resourceGroups.clear();
    this.modifiedFiles.clear();
    this.cachedChangedRanges.clear();
    this.previousBlockSnapshot.clear();
    vscode.commands.executeCommand('setContext', 'sshfs:hasChanges', false);
    vscode.commands.executeCommand('setContext', 'sshfs:cursorOnChange', false);
  }
}

/**
 * Provides the original (cached) content for ssh-original:// URIs.
 * VS Code calls this when it needs to diff the current document against the baseline.
 */
class SSHOriginalContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly cache: Map<string, Uint8Array>) { }

  provideTextDocumentContent(uri: vscode.Uri): string | undefined {
    const key = `${uri.authority}${uri.path}`;
    const content = this.cache.get(key);
    if (!content) return undefined;
    return new TextDecoder().decode(content);
  }
}

/** Singleton instance — created in extension.ts, used by SSHFileSystem */
let instance: SSHQuickDiffManager | undefined;

export function getQuickDiffManager(): SSHQuickDiffManager | undefined {
  return instance;
}

export function createQuickDiffManager(): SSHQuickDiffManager {
  instance = new SSHQuickDiffManager();
  return instance;
}
