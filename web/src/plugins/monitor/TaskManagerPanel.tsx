// Task Manager panel (docs/features/34-system-monitor.md):
// A Tern-inspired live process explorer that works both in the right sidebar
// and as a full workspace pane/tab. Supports Tree View (parent→child hierarchy
// with subtree CPU/memory rollups) and Flat List, live fuzzy search with
// ancestor preservation, windowed rendering for thousands of processes,
// keyboard navigation, context menu, and audited process signaling.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  List,
  ListTree,
  Pause,
  Play,
  RefreshCw,
  Search,
  Skull,
  Square,
  X,
} from 'lucide-react';
import { useStore } from '../../state/store';
import { useSettings } from '../../settings';
import { t, type MessageKey } from '../../i18n';
import { Picker, type PickerItem } from '../../components/Picker';
import { Highlight } from '../../components/Highlight';
import { useScrollView, visibleRange, revealTop } from '../../lib/windowed';
import { openMenu, type MenuEntry } from '../../contextMenu';
import { confirmDialog } from '../../dialog';
import { errorText, type ProcessInfo, type SignalName } from './api';
import {
  buildFlatProcessList,
  buildProcessTree,
  collectSubtreePids,
  flattenProcessTree,
  formatBytes,
  formatPct,
  metricLevel,
  peakGpuPct,
  type DisplayProcessRow,
  type SortDir,
  type SortKey,
} from './model';
import { fetchMetrics, fetchProcesses, sendProcessSignal, useMonitor } from './state';

const ROW_HEIGHT = 26;

function refreshMs(val: unknown): number {
  const sec = typeof val === 'number' && Number.isFinite(val) ? val : 2;
  return Math.max(1, Math.min(30, sec)) * 1000;
}

export function TaskManagerPanel() {
  const order = useStore((s) => s.order);
  const machines = useStore((s) => s.machines);
  const activeMachine = useStore((s) => s.machineId);
  const readOnly = useStore((s) => s.readOnly);
  const intervalMs = useSettings((s) => refreshMs(s.values['monitor.refreshSeconds']?.value));
  const confirmKill = useSettings((s) => s.values['monitor.confirmKill']?.value !== false);

  const targetMachine = useMonitor((s) => s.targetMachine);
  const setTargetMachine = useMonitor((s) => s.setTargetMachine);
  const m = targetMachine && machines[targetMachine] ? targetMachine : activeMachine;
  const machine = m ? machines[m] : undefined;

  const st = useMonitor((s) => (m ? s.machines[m] : undefined));
  const metrics = st?.metrics;
  const procReply = st?.processes;

  const [viewMode, setViewMode] = useState<'tree' | 'list'>('tree');
  const [sortKey, setSortKey] = useState<SortKey>('cpu');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [query, setQuery] = useState('');
  const [paused, setPaused] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());
  const [selectedPid, setSelectedPid] = useState<number | undefined>();

  const searchRef = useRef<HTMLInputElement>(null);
  const scrollElRef = useRef<HTMLDivElement | null>(null);
  const scrollView = useScrollView(420);

  const bindScroll = useCallback(
    (el: HTMLDivElement | null) => {
      scrollElRef.current = el;
      scrollView.ref(el);
    },
    [scrollView],
  );

  // Reset collapse & selection state when switching machines.
  useEffect(() => {
    setCollapsed(new Set());
    setSelectedPid(undefined);
  }, [m]);

  // Poll metrics and processes while mounted and unpaused.
  useEffect(() => {
    if (!m || machine?.status !== 'ready') return;
    const ac = new AbortController();
    const poll = () => {
      if (ac.signal.aborted || document.hidden) return;
      void fetchMetrics(m, ac.signal);
      void fetchProcesses(m, ac.signal);
    };
    poll();
    if (paused) return () => ac.abort();
    const timer = setInterval(poll, intervalMs);
    const onVis = () => {
      if (!document.hidden) poll();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      ac.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [m, machine?.status, paused, intervalMs]);

  const processes = useMemo(() => procReply?.processes ?? [], [procReply]);

  const treeRoots = useMemo(
    () => (viewMode === 'tree' ? buildProcessTree(processes, sortKey, sortDir) : []),
    [processes, viewMode, sortKey, sortDir],
  );

  const rows: DisplayProcessRow[] = useMemo(() => {
    if (viewMode === 'tree') return flattenProcessTree(treeRoots, collapsed, query);
    return buildFlatProcessList(processes, sortKey, sortDir, query);
  }, [viewMode, treeRoots, collapsed, query, processes, sortKey, sortDir]);

  const selectedProc = useMemo(
    () => (selectedPid !== undefined ? processes.find((p) => p.pid === selectedPid) : undefined),
    [processes, selectedPid],
  );

  const toggleSort = useCallback((key: SortKey) => {
    setSortKey((prev) => {
      if (prev === key) {
        setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
        return prev;
      }
      setSortDir(key === 'name' || key === 'pid' ? 'asc' : 'desc');
      return key;
    });
  }, []);

  const toggleCollapse = useCallback((pid: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(pid)) next.delete(pid);
      else next.add(pid);
      return next;
    });
  }, []);

  const expandAll = useCallback(() => setCollapsed(new Set()), []);

  const collapseAll = useCallback(() => {
    const parents = new Set<number>();
    const walk = (nodes: typeof treeRoots) => {
      for (const n of nodes) {
        if (n.children.length > 0) {
          parents.add(n.proc.pid);
          walk(n.children);
        }
      }
    };
    walk(treeRoots);
    setCollapsed(parents);
  }, [treeRoots]);

  const copyValue = useCallback((text: string, what: string) => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => useStore.getState().toast(t('monitor.tm.copied', { what })))
      .catch(() => {});
  }, []);

  const runSignal = useCallback(
    async (proc: ProcessInfo, sig: SignalName) => {
      if (!m || !machine || readOnly) return;
      if (confirmKill && (sig === 'TERM' || sig === 'KILL')) {
        const action = sig === 'KILL' ? t('monitor.tm.kill') : t('monitor.tm.terminate');
        const ok = await confirmDialog({
          title: t('monitor.tm.confirmTitle', { action }),
          message: t('monitor.tm.confirmMessage', { signal: `SIG${sig}`, name: proc.name, pid: proc.pid, machine: machine.label }),
          confirm: action,
          danger: sig === 'KILL',
        });
        if (!ok) return;
      }
      try {
        await sendProcessSignal(m, proc.pid, sig);
        useStore.getState().toast(t('monitor.tm.signalSent', { signal: `SIG${sig}`, name: proc.name, pid: proc.pid }));
      } catch (err) {
        useStore.getState().toast(errorText(err), undefined, undefined, 'error');
      }
    },
    [m, machine, readOnly, confirmKill],
  );

  const openProcessMenu = useCallback(
    (e: React.MouseEvent, row: DisplayProcessRow) => {
      const proc = row.proc;
      const entries: MenuEntry[] = [
        { label: t('monitor.tm.copyPid'), run: () => copyValue(String(proc.pid), `PID ${proc.pid}`) },
        { label: t('monitor.tm.copyCommand'), run: () => copyValue(proc.command || proc.name, proc.name) },
      ];
      if (proc.user) {
        entries.push({ label: t('monitor.tm.filterUser', { user: proc.user }), run: () => setQuery(proc.user) });
      }
      if (viewMode === 'tree' && row.hasChildren && !query.trim()) {
        entries.push('sep');
        entries.push({
          label: t('monitor.tm.expandSubtree'),
          run: () => {
            const pids = collectSubtreePids(treeRoots, proc.pid);
            setCollapsed((prev) => {
              const next = new Set(prev);
              for (const pid of pids) next.delete(pid);
              return next;
            });
          },
        });
        entries.push({
          label: t('monitor.tm.collapseSubtree'),
          run: () => {
            const pids = collectSubtreePids(treeRoots, proc.pid);
            setCollapsed((prev) => {
              const next = new Set(prev);
              for (const pid of pids) next.add(pid);
              return next;
            });
          },
        });
      }
      if (!readOnly && proc.pid > 1) {
        entries.push('sep');
        entries.push({ label: t('monitor.tm.terminate'), run: () => void runSignal(proc, 'TERM') });
        entries.push({ label: t('monitor.tm.kill'), danger: true, run: () => void runSignal(proc, 'KILL') });
        entries.push('sep');
        entries.push({ label: t('monitor.tm.stop'), run: () => void runSignal(proc, 'STOP') });
        entries.push({ label: t('monitor.tm.cont'), run: () => void runSignal(proc, 'CONT') });
      }
      openMenu(e, entries);
    },
    [copyValue, viewMode, query, treeRoots, readOnly, runSignal],
  );

  const onListKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === '/' || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f')) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (!rows.length) return;
      const idx = selectedPid !== undefined ? rows.findIndex((r) => r.proc.pid === selectedPid) : -1;
      const moveTo = (nextIdx: number) => {
        const clamped = Math.max(0, Math.min(rows.length - 1, nextIdx));
        const target = rows[clamped];
        if (!target) return;
        setSelectedPid(target.proc.pid);
        const el = scrollElRef.current;
        if (el) {
          el.scrollTop = revealTop(el.scrollTop, el.clientHeight, clamped * ROW_HEIGHT, (clamped + 1) * ROW_HEIGHT);
        }
      };

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          moveTo(idx < 0 ? 0 : idx + 1);
          break;
        case 'ArrowUp':
          e.preventDefault();
          moveTo(idx < 0 ? 0 : idx - 1);
          break;
        case 'Home':
          e.preventDefault();
          moveTo(0);
          break;
        case 'End':
          e.preventDefault();
          moveTo(rows.length - 1);
          break;
        case 'ArrowRight':
          if (viewMode === 'tree' && idx >= 0 && rows[idx].hasChildren && !rows[idx].expanded) {
            e.preventDefault();
            toggleCollapse(rows[idx].proc.pid);
          }
          break;
        case 'ArrowLeft':
          if (viewMode === 'tree' && idx >= 0) {
            e.preventDefault();
            if (rows[idx].hasChildren && rows[idx].expanded) {
              toggleCollapse(rows[idx].proc.pid);
            } else if (rows[idx].depth > 0) {
              const parentIdx = rows.findIndex((r) => r.proc.pid === rows[idx].proc.ppid);
              if (parentIdx >= 0) moveTo(parentIdx);
            }
          }
          break;
      }
    },
    [rows, selectedPid, viewMode, toggleCollapse],
  );

  const machineItems: PickerItem[] = useMemo(
    () =>
      order
        .map((id) => machines[id])
        .filter((x): x is NonNullable<typeof x> => !!x)
        .map((x) => ({
          value: x.id,
          label: x.label,
          description: t(`machine.${x.status}` as MessageKey),
        })),
    [order, machines],
  );

  const [first, last] = visibleRange(rows.length, ROW_HEIGHT, scrollView.top, scrollView.height || 420);
  const totalHeight = rows.length * ROW_HEIGHT;
  const gpuPeak = peakGpuPct(metrics?.gpus);

  const matchedCount = useMemo(() => rows.filter((r) => !r.ancestorOnly).length, [rows]);

  if (!m || !machine) {
    return <div className="monitor-tm monitor-tm-empty muted">{t('monitor.noMachine')}</div>;
  }

  return (
    <div className="monitor-tm" data-machine={m}>
      {/* Compact resource & machine header */}
      <div className="monitor-tm-summary">
        {machineItems.length > 1 ? (
          <div className="monitor-tm-machine">
            <Picker items={machineItems} value={m} onChange={(v) => setTargetMachine(v)} label={t('sidebar.machines')} />
          </div>
        ) : (
          <span className="monitor-tm-machine-label ellipsis">{machine.label}</span>
        )}
        {metrics && (
          <div className="monitor-tm-pills">
            <span className={`monitor-pill level-${metricLevel(metrics.cpu.usagePct)}`}>
              {t('monitor.cpu')} {formatPct(metrics.cpu.usagePct)}
            </span>
            <span className={`monitor-pill level-${metricLevel(metrics.memory.usedPct)}`}>
              {t('monitor.memory')} {formatPct(metrics.memory.usedPct)}
            </span>
            {gpuPeak !== undefined && (
              <span className={`monitor-pill level-${metricLevel(gpuPeak)}`}>
                {t('monitor.gpu')} {formatPct(gpuPeak)}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Search + View mode + Controls */}
      <div className="monitor-tm-toolbar">
        <div className="monitor-search-box">
          <Search className="monitor-search-icon" />
          <input
            ref={searchRef}
            type="text"
            className="monitor-search-input"
            value={query}
            placeholder={t('monitor.tm.search')}
            aria-label={t('monitor.tm.search')}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.stopPropagation();
                setQuery('');
              }
            }}
          />
          {query && (
            <button
              className="icon monitor-search-clear"
              title={t('monitor.tm.clearSearch')}
              aria-label={t('monitor.tm.clearSearch')}
              onClick={() => setQuery('')}
            >
              <X />
            </button>
          )}
        </div>

        <div className="monitor-tm-controls">
          <div className="monitor-seg" role="group" aria-label={t('monitor.tm.treeView')}>
            <button
              className={`icon ${viewMode === 'tree' ? 'active' : ''}`}
              title={t('monitor.tm.treeView')}
              aria-label={t('monitor.tm.treeView')}
              aria-pressed={viewMode === 'tree'}
              onClick={() => setViewMode('tree')}
            >
              <ListTree />
            </button>
            <button
              className={`icon ${viewMode === 'list' ? 'active' : ''}`}
              title={t('monitor.tm.listView')}
              aria-label={t('monitor.tm.listView')}
              aria-pressed={viewMode === 'list'}
              onClick={() => setViewMode('list')}
            >
              <List />
            </button>
          </div>

          {viewMode === 'tree' && !query.trim() && (
            <>
              <button className="icon" title={t('monitor.tm.expandAll')} aria-label={t('monitor.tm.expandAll')} onClick={expandAll}>
                <ChevronsUpDown />
              </button>
              <button className="icon" title={t('monitor.tm.collapseAll')} aria-label={t('monitor.tm.collapseAll')} onClick={collapseAll}>
                <ChevronsDownUp />
              </button>
            </>
          )}

          <button
            className={`icon ${paused ? 'active' : ''}`}
            title={paused ? t('monitor.resume') : t('monitor.pause')}
            aria-label={paused ? t('monitor.resume') : t('monitor.pause')}
            aria-pressed={paused}
            onClick={() => setPaused((p) => !p)}
          >
            {paused ? <Play /> : <Pause />}
          </button>

          <button
            className="icon"
            title={t('monitor.refresh')}
            aria-label={t('monitor.refresh')}
            onClick={() => {
              void fetchMetrics(m);
              void fetchProcesses(m);
            }}
          >
            <RefreshCw className={st?.processesLoading ? 'monitor-spin' : undefined} />
          </button>

          <span className="monitor-tm-count muted">
            {query.trim()
              ? t('monitor.tm.procsFiltered', { shown: matchedCount, total: processes.length })
              : t('monitor.tm.procs', { n: processes.length })}
          </span>
        </div>
      </div>

      {machine.status !== 'ready' ? (
        <div className="monitor-tm-empty muted">{t('monitor.offline', { status: t(`machine.${machine.status}` as MessageKey) })}</div>
      ) : (
        <>
          {/* Sortable column headers */}
          <div className="monitor-tm-cols" role="row">
            <SortCol
              label={t('monitor.tm.colName')}
              active={sortKey === 'name'}
              dir={sortDir}
              className="col-name"
              onClick={() => toggleSort('name')}
            />
            <SortCol
              label={t('monitor.tm.colPid')}
              active={sortKey === 'pid'}
              dir={sortDir}
              className="col-pid"
              onClick={() => toggleSort('pid')}
            />
            <SortCol label={t('monitor.tm.colUser')} active={false} dir={sortDir} className="col-user" />
            <SortCol label={t('monitor.tm.colState')} active={false} dir={sortDir} className="col-state" />
            <SortCol
              label={t('monitor.tm.colCpu')}
              active={sortKey === 'cpu'}
              dir={sortDir}
              className="col-cpu"
              onClick={() => toggleSort('cpu')}
            />
            <SortCol
              label={t('monitor.tm.colMem')}
              active={sortKey === 'mem'}
              dir={sortDir}
              className="col-mem"
              onClick={() => toggleSort('mem')}
            />
          </div>

          {st?.processesError && <div className="monitor-error small monitor-tm-err">{st.processesError}</div>}

          {/* Windowed process list / tree */}
          <div
            ref={bindScroll}
            className="monitor-tm-scroll"
            role={viewMode === 'tree' ? 'tree' : 'listbox'}
            aria-label={t('monitor.taskManager')}
            tabIndex={0}
            onScroll={scrollView.onScroll}
            onKeyDown={onListKeyDown}
          >
            {!procReply && st?.processesLoading ? (
              <div className="monitor-tm-empty muted">{t('monitor.loadingProcs')}</div>
            ) : rows.length === 0 ? (
              <div className="monitor-tm-empty muted">{t('monitor.tm.empty')}</div>
            ) : (
              <div className="tree" style={{ height: totalHeight }}>
                {rows.slice(first, last).map((row, i) => {
                  const index = first + i;
                  const proc = row.proc;
                  const selected = proc.pid === selectedPid;
                  const cpuShown = viewMode === 'tree' && row.hasChildren && !row.expanded ? row.subtreeCpu : proc.cpuPct;
                  const rssShown = viewMode === 'tree' && row.hasChildren && !row.expanded ? row.subtreeRss : proc.rssBytes;
                  const cpuLevel = metricLevel(cpuShown);

                  return (
                    <div
                      key={proc.pid}
                      role={viewMode === 'tree' ? 'treeitem' : 'option'}
                      aria-level={viewMode === 'tree' ? row.depth + 1 : undefined}
                      aria-expanded={viewMode === 'tree' && row.hasChildren ? row.expanded : undefined}
                      aria-selected={selected}
                      data-pid={proc.pid}
                      className={`monitor-proc-row ${selected ? 'selected' : ''} ${row.ancestorOnly ? 'ancestor' : ''}`}
                      style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}
                      title={proc.command || proc.name}
                      onClick={() => setSelectedPid(proc.pid)}
                      onDoubleClick={() => {
                        if (viewMode === 'tree' && row.hasChildren && !query.trim()) toggleCollapse(proc.pid);
                      }}
                      onContextMenu={(e) => {
                        setSelectedPid(proc.pid);
                        openProcessMenu(e, row);
                      }}
                    >
                      <div className="col-name">
                        {viewMode === 'tree' && (
                          <>
                            {Array.from({ length: Math.min(row.depth, 10) }, (_, g) => (
                              <span key={g} className="tree-guide" aria-hidden />
                            ))}
                            <span
                              className="tree-twisty"
                              aria-hidden
                              onClick={
                                row.hasChildren && !query.trim()
                                  ? (e) => {
                                      e.stopPropagation();
                                      toggleCollapse(proc.pid);
                                    }
                                  : undefined
                              }
                            >
                              {row.hasChildren && (row.expanded ? <ChevronDown /> : <ChevronRight />)}
                            </span>
                          </>
                        )}
                        <span className="monitor-proc-name ellipsis">
                          <Highlight text={proc.name} ranges={row.nameRanges} />
                        </span>
                        {viewMode === 'tree' && row.hasChildren && !row.expanded && (
                          <span className="monitor-child-badge" title={t('monitor.tm.children', { n: row.descendantCount })}>
                            +{row.descendantCount}
                          </span>
                        )}
                      </div>

                      <span className="col-pid monitor-nums muted">{proc.pid}</span>
                      <span className="col-user muted ellipsis">{proc.user}</span>
                      <span
                        className={`col-state monitor-state st-${proc.state}`}
                        title={t(`monitor.tm.state.${proc.state}` as MessageKey)}
                      >
                        {proc.state}
                      </span>
                      <span className={`col-cpu monitor-nums level-${cpuLevel}`}>{formatPct(cpuShown)}</span>
                      <span className="col-mem monitor-nums">{formatBytes(rssShown)}</span>

                      {!readOnly && proc.pid > 1 && (
                        <span className="monitor-proc-actions" onClick={(e) => e.stopPropagation()}>
                          <button
                            className="icon"
                            title={t('monitor.tm.terminate')}
                            aria-label={t('monitor.tm.terminate')}
                            onClick={() => void runSignal(proc, 'TERM')}
                          >
                            <Square />
                          </button>
                          <button
                            className="icon danger"
                            title={t('monitor.tm.kill')}
                            aria-label={t('monitor.tm.kill')}
                            onClick={() => void runSignal(proc, 'KILL')}
                          >
                            <Skull />
                          </button>
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Selected process detail footer */}
          {selectedProc && (
            <div className="monitor-tm-detail">
              <div className="monitor-tm-detail-head">
                <b className="ellipsis">{selectedProc.name}</b>
                <span className="muted monitor-nums">{t('monitor.tm.detailPid', { pid: selectedProc.pid, ppid: selectedProc.ppid })}</span>
                <span className="spacer" />
                <button
                  className="icon"
                  title={t('monitor.tm.copyCommand')}
                  aria-label={t('monitor.tm.copyCommand')}
                  onClick={() => copyValue(selectedProc.command || selectedProc.name, selectedProc.name)}
                >
                  <Copy />
                </button>
                {!readOnly && selectedProc.pid > 1 && (
                  <>
                    <button className="sm" onClick={() => void runSignal(selectedProc, 'TERM')}>
                      {t('monitor.tm.terminate')}
                    </button>
                    <button className="sm danger" onClick={() => void runSignal(selectedProc, 'KILL')}>
                      {t('monitor.tm.kill')}
                    </button>
                  </>
                )}
              </div>
              <div className="monitor-tm-detail-meta muted">
                <span>{selectedProc.user}</span>
                <span>{t(`monitor.tm.state.${selectedProc.state}` as MessageKey)}</span>
                {selectedProc.elapsed && <span>{t('monitor.tm.detailElapsed', { time: selectedProc.elapsed })}</span>}
                <span>
                  {t('monitor.cpu')} {formatPct(selectedProc.cpuPct)}
                </span>
                <span>
                  {t('monitor.memory')} {formatBytes(selectedProc.rssBytes)} ({formatPct(selectedProc.memPct)})
                </span>
                {selectedProc.gpuMemBytes ? (
                  <span>{t('monitor.tm.detailGpuMem', { size: formatBytes(selectedProc.gpuMemBytes) })}</span>
                ) : null}
              </div>
              <code className="monitor-tm-detail-cmd">{selectedProc.command || selectedProc.name}</code>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SortCol({
  label,
  active,
  dir,
  className,
  onClick,
}: {
  label: string;
  active: boolean;
  dir: SortDir;
  className: string;
  onClick?: () => void;
}) {
  if (!onClick) return <span className={`monitor-col ${className}`}>{label}</span>;
  return (
    <button
      className={`monitor-col sortable ${className} ${active ? 'active' : ''}`}
      title={t('monitor.tm.sortBy', { field: label })}
      onClick={onClick}
    >
      <span>{label}</span>
      {active && <span className="monitor-sort-arrow">{dir === 'asc' ? '▲' : '▼'}</span>}
    </button>
  );
}
