import { Eye } from 'lucide-react';
import { useStore } from '../state/store';
import { terms, useTerms } from '../state/terms';
import * as L from '../term/layout';
import { agentOf, agentStatus, paneName, shortPath, terminalTitle } from '../lib/machine';
import { actions, dirname, paneTitle } from '../actions';
import { StatusDot } from './StatusDot';
import { InlineEdit } from './InlineEdit';
import { CodeIcon } from './icons';
import { startPaneDrag } from '../paneDrag';
import { openMenu } from '../contextMenu';
import { paneMenu } from '../menus';
import { PaneActions } from './PaneActions';
import { t } from '../i18n';

interface Props {
  m: string;
  /** The pane's key (term/layout.ts paneKey). */
  pane: string;
  leaf: L.Leaf;
  ws: string;
  focused: boolean;
  zoomed: boolean;
}

/** The header of one pane: for a terminal the agent's state, the title, the
 * agent and the folder; for VS Code its mark, the folder's name and path;
 * for a preview the file's name and directory. Then the pane's own buttons
 * (PaneActions). Pressing it focuses the pane (VS Code takes the
 * keyboard), dragging it moves the pane, its menu has the pane's commands. */
export function PaneHeader({ m, pane, leaf, ws, focused, zoomed }: Props) {
  const readOnly = useStore((s) => s.readOnly);
  const home = useStore((s) => s.machines[m]?.info?.home);
  const machine = useStore((s) => s.machines[m]?.label ?? m);
  // The terminal's record, for its title, agent and folder.
  useTerms((s) => (L.isTerminalLeaf(leaf) ? s.machines[m]?.terminals[pane] : undefined));
  const title = paneTitle(m, leaf, pane);
  return (
    <div
      className={`pane-header ${readOnly || zoomed ? '' : 'draggable'} ${focused ? 'focused' : ''}`}
      data-pane={pane}
      data-m={m}
      onPointerDown={(ev) => {
        if (ev.button !== 0 || readOnly || zoomed || (ev.target as HTMLElement).closest('button, input')) return;
        startPaneDrag(ev, { m, pane, ws, label: title });
      }}
      onMouseDown={(e) => !(e.target as HTMLElement).closest('button, input') && actions.focusPane(m, pane)}
      onContextMenu={(e) => !(e.target as HTMLElement).closest('input') && openMenu(e, paneMenu(m, pane))}
    >
      {L.isTerminalLeaf(leaf) ? (
        <TerminalHeading m={m} terminal={pane} home={home} />
      ) : L.isCodeLeaf(leaf) ? (
        <>
          <CodeIcon className="pane-kind" />
          <span className="pane-title" title={t('code.paneTitle', { machine, folder: leaf.code.folder || '~' })}>
            {title}
          </span>
          <span className="pane-cwd" title={leaf.code.folder}>
            <bdi>{shortPath(leaf.code.folder, home)}</bdi>
          </span>
        </>
      ) : (
        <>
          <Eye className="pane-kind" />
          <span className="pane-title" title={t('preview.paneTitle', { machine, path: leaf.preview.path })}>
            {title}
          </span>
          <span className="pane-cwd" title={dirname(leaf.preview.path)}>
            <bdi>{shortPath(dirname(leaf.preview.path), home)}</bdi>
          </span>
        </>
      )}
      <PaneActions m={m} pane={pane} leaf={leaf} zoomed={zoomed} />
    </div>
  );
}

/** A terminal's state, title (renamed by a double click), agent and folder. */
function TerminalHeading({ m, terminal, home }: { m: string; terminal: string; home?: string }) {
  const record = useTerms((s) => s.machines[m]?.terminals[terminal]);
  const agent = agentOf(record);
  const status = agentStatus(record);
  const cwd = terms.directory(m, terminal);
  return (
    <>
      {status && <StatusDot status={status} />}
      <PaneTitle m={m} terminal={terminal} title={terminalTitle(record, terminal)} name={paneName(record)} />
      {agent && <span className="pane-agent">{agent}</span>}
      <span className="pane-cwd" title={cwd}>
        <bdi>{shortPath(cwd, home)}</bdi>
      </span>
    </>
  );
}

/** A pane's title; double-clicking it renames the pane (unless read-only),
 * as tabs and workspaces are renamed. */
export function PaneTitle({ m, terminal, title, name }: { m: string; terminal: string; title: string; name: string }) {
  const readOnly = useStore((s) => s.readOnly);
  const renaming = useStore((s) => s.renaming?.kind === 'pane' && s.renaming.m === m && s.renaming.id === terminal);
  const setRenaming = useStore((s) => s.setRenaming);
  if (renaming)
    return (
      <InlineEdit
        className="pane-title-edit"
        value={name || title}
        onDone={(v) => {
          setRenaming(undefined);
          if (v !== undefined && v !== name) void actions.renamePane(m, terminal, v);
        }}
      />
    );
  return (
    <span
      className={`pane-title ${readOnly ? '' : 'editable'}`}
      title={readOnly ? title : t('pane.rename', { label: name || title })}
      onDoubleClick={() => !readOnly && setRenaming({ kind: 'pane', m, id: terminal })}
    >
      {name || title}
    </span>
  );
}
