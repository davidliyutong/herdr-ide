// The migrate plugin's status bar item and dialog: while a connected
// machine has a namespace of a previous product name, the item says so;
// the dialog lists that namespace's workspaces and tabs with what runs in
// them, moves the tabs picked into this namespace (plan.ts), stops the
// previous terminal core and removes its files.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRightLeft, X } from 'lucide-react';
import { t } from '../../i18n';
import { APP_NAME } from '../../brand';
import { useStore } from '../../state/store';
import { terms } from '../../state/terms';
import * as L from '../../term/layout';
import { agentKind } from '../../conversation/kinds';
import {
  migrateErrorText,
  migrateRelease,
  migrateRemove,
  migrateScan,
  migrateStatus,
  migrateStop,
  MigrateError,
  type MigrateScan,
  type MigrateStatus,
} from './api';
import { placeTabs, startDirectory, takeTabs, type OldTerminal, type Picked } from './plan';

/** How often the item asks the connected machines. */
const POLL_MS = 60_000;

/** The previous namespaces of the connected machines, by machine. */
function useStatuses(): [Record<string, MigrateStatus>, () => void] {
  const ready = useStore((s) => s.order.filter((m) => s.machines[m]?.status === 'ready').join('\n'));
  const [statuses, setStatuses] = useState<Record<string, MigrateStatus>>({});
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    let live = true;
    const machines = ready ? ready.split('\n') : [];
    const ask = () =>
      Promise.all(
        machines.map((m) =>
          migrateStatus(m).then(
            (s) => [m, s] as const,
            () => [m, undefined] as const,
          ),
        ),
      ).then((all) => {
        if (!live) return;
        const next: Record<string, MigrateStatus> = {};
        for (const [m, s] of all) if (s?.slug) next[m] = s;
        setStatuses(next);
      });
    void ask();
    const timer = setInterval(() => void ask(), POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [ready, tick]);
  return [statuses, refresh];
}

/** The status bar's item: shown while a machine has a previous namespace. */
export function MigrateItem() {
  const [statuses, refresh] = useStatuses();
  const [open, setOpen] = useState(false);
  const machines = Object.keys(statuses);
  if (!machines.length && !open) return null;
  const slug = Object.values(statuses)[0]?.slug ?? '';
  const terminals = Object.values(statuses).reduce((n, s) => n + (s.terminals || 0), 0);
  return (
    <>
      <button className="migrate-status-item" title={t('migrate.itemTitle', { old: slug, app: APP_NAME })} onClick={() => setOpen(true)}>
        <ArrowRightLeft />
        <span>{t('migrate.item', { old: slug, n: terminals })}</span>
      </button>
      {/* On the page's body: the status bar's own layout would hold it. */}
      {open &&
        createPortal(
          <MigrateDialog
            statuses={statuses}
            onClose={() => {
              setOpen(false);
              refresh();
            }}
            onChange={refresh}
          />,
          document.body,
        )}
    </>
  );
}

/** What runs in a terminal of the previous namespace, as the dialog says it. */
function describe(info: OldTerminal | undefined, leaf: L.TerminalLeaf): string {
  const agent = info?.agent ?? (typeof leaf.agent === 'string' ? leaf.agent : undefined);
  const kind = agentKind(agent);
  if (kind)
    return info?.session || leaf.session ? t('migrate.agentSession', { agent: kind.title }) : t('migrate.agent', { agent: kind.title });
  if (!info) return t('migrate.ended');
  if (info.program) return t('migrate.program', { program: info.program });
  return t('migrate.shell');
}

/** A leaf that is not a terminal, as the dialog says it. */
function describeView(leaf: L.Leaf): string {
  if (L.isCodeLeaf(leaf)) return t('migrate.code', { folder: leaf.code.folder || '~' });
  if (L.isPreviewLeaf(leaf)) return t('migrate.preview', { path: leaf.preview.path });
  if (L.isPluginLeaf(leaf)) return t('migrate.view', { kind: leaf.view.kind });
  return '';
}

/** Terminals that run a program other than a coding agent, which moving ends. */
function programsEnding(scan: MigrateScan, layout: L.Layout, picked: readonly Picked[]): string[] {
  const info = new Map((scan.terminal_list ?? []).map((x) => [x.address, x]));
  return takeTabs(layout, picked).terminals.flatMap((a) => {
    const x = info.get(a);
    return x?.program && !x.agent ? [x.program] : [];
  });
}

function MigrateDialog({ statuses, onClose, onChange }: { statuses: Record<string, MigrateStatus>; onClose(): void; onChange(): void }) {
  const machines = useStore((s) => s.machines);
  const readOnly = useStore((s) => s.readOnly);
  const ids = Object.keys(statuses);
  const [m, setM] = useState(ids[0] ?? '');
  const [scan, setScan] = useState<MigrateScan>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<Picked[]>([]);
  const [armed, setArmed] = useState<'' | 'move' | 'stop' | 'remove'>('');
  const [done, setDone] = useState('');

  const load = useCallback(() => {
    if (!m) return;
    setError('');
    setPicked([]);
    setArmed('');
    migrateScan(m).then(setScan, (e) => {
      setScan(undefined);
      // A previous terminal core that no longer runs leaves its files.
      if (!(e instanceof MigrateError && e.code === 'not_running')) setError(migrateErrorText(e));
    });
  }, [m]);
  useEffect(load, [load]);

  const layout = useMemo(() => L.parseLayout(scan?.layout ?? null), [scan]);
  const info = useMemo(() => new Map((scan?.terminal_list ?? []).map((x) => [x.address, x])), [scan]);
  const status = statuses[m] ?? scan;
  const isPicked = (w: string, i: number) => picked.some((p) => p.workspace === w && p.tab === i);
  const toggle = (w: string, i: number) =>
    setPicked((ps) => (isPicked(w, i) ? ps.filter((p) => !(p.workspace === w && p.tab === i)) : [...ps, { workspace: w, tab: i }]));
  const toggleWorkspace = (ws: L.Workspace) => {
    const all = ws.tabs.every((_, i) => isPicked(ws.id, i));
    setPicked((ps) => [...ps.filter((p) => p.workspace !== ws.id), ...(all ? [] : ws.tabs.map((_, i) => ({ workspace: ws.id, tab: i })))]);
  };

  const run = async (what: () => Promise<string>) => {
    setBusy(true);
    setError('');
    setDone('');
    try {
      setDone(await what());
    } catch (e) {
      setError(migrateErrorText(e));
    } finally {
      setBusy(false);
      setArmed('');
      onChange();
      load();
    }
  };

  const move = () =>
    run(async () => {
      if (!scan) return '';
      const taken = takeTabs(layout, picked);
      // New shells first, in each terminal's directory: should giving up
      // the previous ones fail, these end and nothing changed.
      const started = new Map<string, string>();
      for (const g of taken.groups) {
        for (const tab of g.tabs) {
          for (const a of L.tabTerminals(tab)) {
            const address = await terms.run(m, { cwd: startDirectory(a, g, info) }, (l) => l);
            if (address) started.set(a, address);
          }
        }
      }
      try {
        await migrateRelease(
          m,
          taken.rest,
          scan.layout_version,
          taken.terminals.filter((a) => info.has(a)),
        );
      } catch (e) {
        for (const a of started.values()) void terms.kill(m, a);
        throw e;
      }
      terms.mutate(m, (l) => placeTabs(l, taken.groups, started, info));
      useStore.getState().selectMachine(m);
      return t('migrate.moved', { n: taken.groups.reduce((n, g) => n + g.tabs.length, 0) });
    });

  const ending = scan && armed === 'move' ? programsEnding(scan, layout, picked) : [];
  const label = (id: string) => machines[id]?.label ?? id;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div
        className="modal dialog migrate-dialog"
        role="dialog"
        aria-label={t('migrate.title', { old: status?.slug ?? '', app: APP_NAME })}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape' && !busy) onClose();
        }}
      >
        <div className="modal-head">
          <span className="modal-title">{t('migrate.title', { old: status?.slug ?? '', app: APP_NAME })}</span>
          <span className="spacer" />
          <button className="icon" title={t('dialog.cancel')} onClick={onClose} disabled={busy}>
            <X />
          </button>
        </div>
        <div className="dialog-body migrate-body">
          <p className="migrate-intro">{t('migrate.intro', { old: status?.slug ?? '', app: APP_NAME })}</p>
          {ids.length > 1 && (
            <label className="row migrate-machine">
              <span>{t('migrate.machine')}</span>
              <select value={m} onChange={(e) => setM(e.target.value)} disabled={busy}>
                {ids.map((id) => (
                  <option key={id} value={id}>
                    {label(id)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {status?.node && <p className="migrate-note">{t('migrate.oldConnected', { old: status.slug ?? '' })}</p>}
          {!status?.running && <p className="migrate-note">{t('migrate.notRunning', { old: status?.slug ?? '' })}</p>}
          {scan && !layout.workspaces.some((w) => w.tabs.length) && <p className="migrate-note">{t('migrate.empty')}</p>}
          <ul className="migrate-tree">
            {layout.workspaces.map((ws) =>
              ws.tabs.length ? (
                <li key={ws.id}>
                  <label className="row migrate-workspace">
                    <input
                      type="checkbox"
                      checked={ws.tabs.every((_, i) => isPicked(ws.id, i))}
                      onChange={() => toggleWorkspace(ws)}
                      disabled={busy}
                    />
                    <span>{L.workspaceTitle(ws)}</span>
                  </label>
                  <ul>
                    {ws.tabs.map((tab, i) => (
                      <li key={i}>
                        <label className="row migrate-tab">
                          <input type="checkbox" checked={isPicked(ws.id, i)} onChange={() => toggle(ws.id, i)} disabled={busy} />
                          <span>{tab.name || t('migrate.tab', { n: i + 1 })}</span>
                        </label>
                        <ul className="migrate-panes">
                          {L.leavesOf(tab.root).map((leaf, j) =>
                            L.isTerminalLeaf(leaf) ? (
                              <li key={j}>
                                <span className="migrate-what">{describe(info.get(leaf.terminal), leaf)}</span>
                                <span className="migrate-dir">{info.get(leaf.terminal)?.cwd ?? ''}</span>
                              </li>
                            ) : (
                              <li key={j}>
                                <span className="migrate-what">{describeView(leaf)}</span>
                              </li>
                            ),
                          )}
                        </ul>
                      </li>
                    ))}
                  </ul>
                </li>
              ) : null,
            )}
          </ul>
        </div>
        <div className="migrate-messages" aria-live="polite">
          {armed === 'move' && (
            <p className="migrate-warn">
              {ending.length ? t('migrate.confirmMoveEnding', { programs: ending.join(', ') }) : t('migrate.confirmMove')}
            </p>
          )}
          {armed === 'stop' && <p className="migrate-warn">{t('migrate.confirmStop', { n: status?.terminals ?? 0 })}</p>}
          {armed === 'remove' && <p className="migrate-warn">{t('migrate.confirmRemove', { dir: status?.dir ?? '' })}</p>}
          {error && <p className="migrate-error">{error}</p>}
          {done && <p className="migrate-done">{done}</p>}
        </div>
        <div className="dialog-actions">
          {status?.running ? (
            <button
              className="danger"
              disabled={busy || readOnly}
              onClick={() => (armed === 'stop' ? run(async () => (await migrateStop(m), t('migrate.stopped'))) : setArmed('stop'))}
            >
              {armed === 'stop' ? t('migrate.stopConfirm') : t('migrate.stop')}
            </button>
          ) : (
            <button
              className="danger"
              disabled={busy || readOnly}
              onClick={() => (armed === 'remove' ? run(async () => (await migrateRemove(m), t('migrate.removed'))) : setArmed('remove'))}
            >
              {armed === 'remove' ? t('migrate.removeConfirm') : t('migrate.remove')}
            </button>
          )}
          <span className="spacer" />
          {armed && (
            <button onClick={() => setArmed('')} disabled={busy}>
              {t('dialog.cancel')}
            </button>
          )}
          <button
            className="primary"
            disabled={busy || readOnly || !picked.length || !scan}
            onClick={() => (armed === 'move' ? move() : setArmed('move'))}
          >
            {armed === 'move' ? t('migrate.moveConfirm', { n: picked.length }) : t('migrate.move', { n: picked.length, app: APP_NAME })}
          </button>
        </div>
      </div>
    </div>
  );
}
