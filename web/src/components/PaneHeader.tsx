import { useStore } from '../state/store';
import { terms, useTerms } from '../state/terms';
import { agentOf, agentStatus, paneName, shortPath, terminalTitle } from '../lib/machine';
import { actions } from '../actions';
import { StatusDot } from './StatusDot';
import { InlineEdit } from './InlineEdit';
import { startPaneDrag } from '../paneDrag';
import { openMenu } from '../contextMenu';
import { paneMenu } from '../menus';
import { PaneActions } from './PaneActions';
import { t } from '../i18n';

interface Props {
  m: string;
  terminal: string;
  ws: string;
  focused: boolean;
  zoomed: boolean;
}

/** The header of one pane, above its terminal: the agent's state, the
 * title, the agent and the folder, then the pane's own buttons
 * (PaneActions). Double-clicking the title renames the pane, dragging the
 * header moves it, its menu has the pane's commands. */
export function PaneHeader({ m, terminal, ws, focused, zoomed }: Props) {
  const record = useTerms((s) => s.machines[m]?.terminals[terminal]);
  const home = useStore((s) => s.machines[m]?.info?.home);
  const readOnly = useStore((s) => s.readOnly);
  const agent = agentOf(record);
  const status = agentStatus(record);
  const cwd = terms.directory(m, terminal);
  const title = terminalTitle(record, terminal);
  return (
    <div
      className={`pane-header ${readOnly || zoomed ? '' : 'draggable'} ${focused ? 'focused' : ''}`}
      data-terminal={terminal}
      data-m={m}
      onPointerDown={(ev) => {
        if (ev.button !== 0 || readOnly || zoomed || (ev.target as HTMLElement).closest('button, input')) return;
        startPaneDrag(ev, { m, terminal, ws, label: title });
      }}
      onMouseDown={(e) => !(e.target as HTMLElement).closest('button, input') && actions.focusTerminal(m, terminal)}
      onContextMenu={(e) => !(e.target as HTMLElement).closest('input') && openMenu(e, paneMenu(m, terminal))}
    >
      {status && <StatusDot status={status} />}
      <PaneTitle m={m} terminal={terminal} title={title} name={paneName(record)} />
      {agent && <span className="pane-agent">{agent}</span>}
      <span className="pane-cwd" title={cwd}>
        <bdi>{shortPath(cwd, home)}</bdi>
      </span>
      <PaneActions m={m} terminal={terminal} cwd={cwd} zoomed={zoomed} />
    </div>
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
        placeholder={t('pane.renamePlaceholder')}
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
