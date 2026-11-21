import { useEffect, useRef } from 'react';
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
import { openPaneMenu, paneMenu } from '../menus';
import { isMenuKey } from '../rowKeys';
import { PaneActions } from './PaneActions';
import { t } from '../i18n';
import { FileTitle, LeafIcon, ViewTitle } from './PluginPane';
import { describeView } from '../plugins/registry';

interface Props {
  m: string;
  /** The pane's key (term/layout.ts paneKey). */
  pane: string;
  leaf: L.Leaf;
  ws: string;
  focused: boolean;
  zoomed: boolean;
}

/** Whether an element of a header is drawn (a narrow header hides some,
 * a pane without the focus its buttons). */
function drawn(el: HTMLElement): boolean {
  const st = getComputedStyle(el);
  return st.display !== 'none' && st.visibility !== 'hidden' && !el.closest('[hidden]');
}

/** A header's keys, as a toolbar's: ← → Home End move between its title
 * (when it can be renamed) and its buttons, Enter or F2 on the header or
 * the title renames the pane, the menu key or Shift+F10 opens the pane's
 * menu, Escape gives the keyboard to the pane. Enter and Space on a button
 * press it. Keys typed in the rename field are its own. */
function onHeaderKey(e: React.KeyboardEvent<HTMLElement>, m: string, pane: string, renamable: boolean) {
  const target = e.target as HTMLElement;
  if (target.closest('input')) return;
  const header = e.currentTarget;
  const items = [...header.querySelectorAll<HTMLElement>('.pane-title.editable, button')].filter(drawn);
  const at = items.indexOf(target);
  const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
  const done = () => {
    e.preventDefault();
    e.stopPropagation();
  };
  const go = (i: number) => {
    done();
    items[Math.max(0, Math.min(items.length - 1, i))]?.focus();
  };
  const onTitle = target === header || target.classList.contains('pane-title');
  if (plain && e.key === 'ArrowRight') go(at < 0 ? 0 : at + 1);
  else if (plain && e.key === 'ArrowLeft') go(at < 0 ? items.length - 1 : at - 1);
  else if (plain && e.key === 'Home') go(0);
  else if (plain && e.key === 'End') go(items.length - 1);
  else if (plain && (e.key === 'F2' || (e.key === 'Enter' && onTitle)) && renamable) {
    done();
    actions.startRename('pane', m, pane);
  } else if (isMenuKey(e)) {
    done();
    openPaneMenu(m, pane);
  } else if (plain && e.key === 'Escape') {
    done();
    actions.focusPane(m, pane);
  }
}

/** The header of one pane: for a terminal the agent's state, the title, the
 * agent and the folder; for VS Code its mark, the folder's name and path;
 * for a preview the file's name and directory. Then the pane's own buttons
 * (PaneActions). Pressing it focuses the pane (VS Code takes the
 * keyboard), dragging it moves the pane, its menu has the pane's commands.
 * It is a toolbar, one stop of the Tab key (onHeaderKey); the keyboard on
 * it makes its pane the focused one, the pane's own keyboard staying put. */
export function PaneHeader({ m, pane, leaf, ws, focused, zoomed }: Props) {
  const readOnly = useStore((s) => s.readOnly);
  const home = useStore((s) => s.machines[m]?.info?.home);
  const machine = useStore((s) => s.machines[m]?.label ?? m);
  // The terminal's record, for its title, agent and folder.
  useTerms((s) => (L.isTerminalLeaf(leaf) ? s.machines[m]?.terminals[pane] : undefined));
  const title = paneTitle(m, leaf, pane);
  const ref = useRef<HTMLDivElement>(null);
  // One stop of the Tab key: the header; its buttons are reached with the arrows.
  useEffect(() => ref.current?.querySelectorAll('button').forEach((b) => (b.tabIndex = -1)));
  return (
    <div
      ref={ref}
      className={`pane-header ${readOnly || zoomed ? '' : 'draggable'} ${focused ? 'focused' : ''}`}
      role="toolbar"
      aria-label={t('pane.toolbar', { title })}
      tabIndex={0}
      data-pane={pane}
      data-m={m}
      onPointerDown={(ev) => {
        if (ev.button !== 0 || readOnly || zoomed || (ev.target as HTMLElement).closest('button, input')) return;
        startPaneDrag(ev, { m, pane, ws, label: title });
      }}
      // A press focuses the pane and leaves the keyboard in it, not on the header.
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).closest('button, input')) return;
        e.preventDefault();
        actions.focusPane(m, pane);
      }}
      onFocus={() => !focused && terms.mutate(m, (l) => L.focusPane(l, pane))}
      onKeyDown={(e) => onHeaderKey(e, m, pane, L.isTerminalLeaf(leaf) && !readOnly)}
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
      ) : L.isPluginLeaf(leaf) ? (
        <PluginHeading m={m} view={leaf.view} home={home} />
      ) : (
        <>
          <Eye className="pane-kind" />
          <FileTitle
            m={m}
            path={leaf.preview.path}
            className="pane-title"
            tooltip={(gone) => [t('preview.paneTitle', { machine, path: leaf.preview.path }), gone].filter(Boolean).join(' · ')}
          >
            {title}
          </FileTitle>
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
      tabIndex={readOnly ? undefined : -1}
      title={readOnly ? title : t('pane.rename', { label: name || title })}
      onDoubleClick={() => !readOnly && setRenaming({ kind: 'pane', m, id: terminal })}
    >
      {name || title}
    </span>
  );
}

/** A plugin's pane: its icon, title and path. */
function PluginHeading({ m, view, home }: { m: string; view: L.PluginView; home?: string }) {
  const d = describeView(m, view);
  return (
    <>
      <LeafIcon m={m} leaf={{ view }} className="pane-kind" />
      <ViewTitle m={m} view={view} className="pane-title" tooltip={(gone) => [d.title, d.path, gone].filter(Boolean).join(' · ')}>
        {d.title}
      </ViewTitle>
      {d.path && (
        <span className="pane-cwd" title={d.path}>
          <bdi>{shortPath(d.path, home)}</bdi>
        </span>
      )}
    </>
  );
}
