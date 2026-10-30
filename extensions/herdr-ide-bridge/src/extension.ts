// Bridge: lets the web IDE drive this code-server window (open files at a
// position, multi-file diff, Git Graph, media preview, light/dark theme) and
// sends editor selections back to the agent pane focused in the web IDE.
//
// The extension host runs on the machine itself and connects to the agent's
// unix socket, which the agent tunnels to the core. The agent passes the
// socket path in <ENV_PREFIX>BRIDGE_SOCKET when it starts code-server.

import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { DATA_DIR, ENV_PREFIX, SLUG } from './brand';

const socketPath = process.env[ENV_PREFIX + 'BRIDGE_SOCKET'] || path.join(os.homedir(), DATA_DIR, 'run', 'bridge.sock');
const windowId = crypto.randomUUID();

let sock: net.Socket | undefined;
let retry = 500;
let disposed = false;
let reconnectTimer: NodeJS.Timeout | undefined;
const log = vscode.window.createOutputChannel(SLUG);

function send(msg: Record<string, unknown>) {
  if (sock && !sock.destroyed) sock.write(JSON.stringify(msg) + '\n');
}

function hello() {
  send({
    type: 'hello',
    id: windowId,
    folders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
  });
}

function connect() {
  if (disposed) return;
  const s = net.createConnection(socketPath);
  let retried = false;
  let buf = '';
  s.setEncoding('utf8');
  s.on('connect', () => {
    sock = s;
    retry = 500;
    log.appendLine(`connected to ${socketPath}`);
    hello();
  });
  s.on('data', (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.type === 'theme') {
        applyTheme(msg.kind).catch((e) => log.appendLine(`theme ${msg.kind} failed: ${e}`));
      } else if (msg.type === 'command') {
        run(msg)
          .then(() => send({ type: 'ack', id: msg.id, ok: true }))
          .catch((e) => {
            log.appendLine(`command ${msg.cmd} failed: ${e}`);
            send({ type: 'ack', id: msg.id, ok: false, error: String(e?.message ?? e) });
          });
      }
    }
  });
  // 'error' is followed by 'close'; schedule one reconnect per socket, and
  // none for a socket that was replaced (e.g. by the reconnect command).
  const again = () => {
    if (retried) return;
    retried = true;
    const current = sock === s || sock === undefined;
    if (sock === s) sock = undefined;
    if (disposed || !current) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, retry);
    retry = Math.min(retry * 2, 10000);
  };
  s.on('error', () => again());
  s.on('close', () => again());
}

/** Follows the web IDE's light/dark choice with the user's preferred light or
 * dark VS Code theme, leaving a theme of the right kind alone. */
async function applyTheme(kind: unknown) {
  if (kind !== 'dark' && kind !== 'light') return;
  const k = vscode.window.activeColorTheme.kind;
  const isDark = k === vscode.ColorThemeKind.Dark || k === vscode.ColorThemeKind.HighContrast;
  if (isDark === (kind === 'dark')) return;
  const wb = vscode.workspace.getConfiguration('workbench');
  const theme =
    kind === 'dark'
      ? wb.get<string>('preferredDarkColorTheme') || 'Default Dark Modern'
      : wb.get<string>('preferredLightColorTheme') || 'Default Light Modern';
  await wb.update('colorTheme', theme, vscode.ConfigurationTarget.Global);
}

async function focusWorkbench() {
  // Reveal the editor area when the panel was opened just for this command.
  await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup').then(undefined, () => {});
}

async function repoRoot(dir?: string): Promise<vscode.Uri | undefined> {
  const git = vscode.extensions.getExtension('vscode.git');
  const api = git?.isActive ? git.exports.getAPI(1) : (await git?.activate())?.getAPI(1);
  if (!api) return dir ? vscode.Uri.file(dir) : undefined;
  if (dir) {
    const target = vscode.Uri.file(dir);
    const repo = api.getRepository(target) ?? (await api.openRepository?.(target));
    if (repo) return repo.rootUri;
  }
  return api.repositories[0]?.rootUri;
}

async function run(msg: any) {
  switch (msg.cmd) {
    case 'openFile': {
      const uri = vscode.Uri.file(msg.path);
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type & vscode.FileType.Directory) {
        await vscode.commands.executeCommand('revealInExplorer', uri);
        return;
      }
      const media = /\.(png|jpe?g|gif|webp|svg|bmp|ico|mp4|webm|mov|mp3|wav|ogg|pdf|ipynb)$/i.test(msg.path);
      if (media || !msg.line) {
        await vscode.commands.executeCommand('vscode.open', uri, { preview: false });
        if (!msg.line) return;
      }
      const line = Math.max(0, (msg.line ?? 1) - 1);
      const col = Math.max(0, (msg.col ?? 1) - 1);
      const pos = new vscode.Position(line, col);
      await vscode.window.showTextDocument(uri, { selection: new vscode.Range(pos, pos), preview: false });
      return;
    }
    case 'openMedia':
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(msg.path), { preview: false });
      return;
    case 'reveal':
      await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(msg.path));
      return;
    case 'openDiff': {
      await repoRoot(msg.repo);
      await vscode.commands.executeCommand('workbench.view.scm');
      // Multi-file diff of the working tree ("View Changes").
      try {
        await vscode.commands.executeCommand('git.viewChanges');
      } catch {
        /* older VS Code: the SCM view is shown */
      }
      await focusWorkbench();
      return;
    }
    case 'gitGraph': {
      const root = await repoRoot(msg.repo);
      const ext = vscode.extensions.getExtension('mhutchie.git-graph');
      if (!ext) throw new Error(vscode.l10n.t('The Git Graph extension is not installed'));
      await ext.activate();
      // Git Graph opens the repository of a SourceControl-like argument.
      await vscode.commands.executeCommand('git-graph.view', root ? { rootUri: root } : undefined);
      return;
    }
    default:
      throw new Error(`unknown command ${msg.cmd}`);
  }
}

async function sendToAgent(uri?: vscode.Uri) {
  const ed = vscode.window.activeTextEditor;
  if (uri && (!ed || ed.document.uri.toString() !== uri.toString())) {
    send({ type: 'sendToAgent', text: '@' + uri.fsPath + ' ', file: uri.fsPath });
    return;
  }
  if (!ed) return;
  const sel = ed.selection;
  const file = ed.document.uri.fsPath;
  const start = sel.start.line + 1;
  const end = sel.end.line + 1;
  const ref = sel.isEmpty ? `@${file}:${start}` : `@${file}:${start}-${end}`;
  const body = sel.isEmpty ? '' : '\n```\n' + ed.document.getText(sel) + '\n```\n';
  send({ type: 'sendToAgent', text: ref + body, file, line: start, end_line: end });
  vscode.window.setStatusBarMessage(vscode.l10n.t('Sent to the focused agent'), 2500);
}

export function activate(ctx: vscode.ExtensionContext) {
  connect();
  ctx.subscriptions.push(
    log,
    vscode.workspace.onDidChangeWorkspaceFolders(() => hello()),
    vscode.window.onDidChangeWindowState((s) => s.focused && send({ type: 'focus' })),
    vscode.commands.registerCommand(`${SLUG}.sendToAgent`, sendToAgent),
    vscode.commands.registerCommand(`${SLUG}.reconnect`, () => {
      clearTimeout(reconnectTimer);
      const old = sock;
      sock = undefined;
      old?.destroy();
      retry = 500;
      connect();
    }),
    { dispose: () => ((disposed = true), clearTimeout(reconnectTimer), sock?.destroy()) },
  );
}

export function deactivate() {
  disposed = true;
  sock?.destroy();
}
