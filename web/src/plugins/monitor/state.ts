// Shared client state for the System Monitor & Task Manager plugin:
// per-machine metric snapshots, rolling sparkline history, process snapshots,
// and in-flight request deduplication.
import { create } from 'zustand';
import { actions } from '../../actions';
import { showPanel } from '../../panelPanes';
import { PANEL_VIEW } from '../registry';
import { useStore } from '../../state/store';
import { errorText, monitorApi, type Metrics, type ProcessesReply, type SignalName } from './api';
import { peakGpuPct } from './model';

/** How many metric samples to retain per machine for sparklines. */
export const HISTORY_LIMIT = 30;

export interface HistoryPoint {
  ts: number;
  cpu: number;
  mem: number;
  gpu?: number;
  rx: number;
  tx: number;
}

export interface MachineMonitorState {
  metrics?: Metrics;
  history: HistoryPoint[];
  metricsLoading: boolean;
  metricsError?: string;
  processes?: ProcessesReply;
  processesLoading: boolean;
  processesError?: string;
}

const emptyMachine = (): MachineMonitorState => ({
  history: [],
  metricsLoading: false,
  processesLoading: false,
});

interface MonitorStore {
  machines: Record<string, MachineMonitorState>;
  /** Optional machine pinned in the Task Manager panel (overrides active machine). */
  targetMachine?: string;
  setTargetMachine(m?: string): void;
}

export const useMonitor = create<MonitorStore>((set) => ({
  machines: {},
  targetMachine: undefined,
  setTargetMachine: (targetMachine) => set({ targetMachine }),
}));

interface InFlight {
  promise: Promise<void>;
  ac: AbortController;
  waiters: number;
}

const inflightMetrics = new Map<string, InFlight>();
const inflightProcesses = new Map<string, InFlight>();

function attachSignal(map: Map<string, InFlight>, key: string, flight: InFlight, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    flight.waiters++;
    return flight.promise;
  }
  if (signal.aborted) return Promise.resolve();
  flight.waiters++;
  let done = false;
  return new Promise<void>((resolve) => {
    const onAbort = () => {
      if (done) return;
      done = true;
      flight.waiters--;
      if (flight.waiters <= 0) {
        if (map.get(key) === flight) map.delete(key);
        flight.ac.abort();
      }
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void flight.promise.finally(() => {
      done = true;
      signal.removeEventListener('abort', onAbort);
      resolve();
    });
  });
}

function patchMachine(m: string, fn: (cur: MachineMonitorState) => MachineMonitorState) {
  useMonitor.setState((s) => ({
    machines: { ...s.machines, [m]: fn(s.machines[m] ?? emptyMachine()) },
  }));
}

/** Fetches one fresh metrics snapshot for machine m (deduplicated in flight;
 * aborts the underlying request if every caller's signal aborts). */
export function fetchMetrics(m: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  const existing = inflightMetrics.get(m);
  if (existing) return attachSignal(inflightMetrics, m, existing, signal);
  const ac = new AbortController();
  patchMachine(m, (cur) => ({ ...cur, metricsLoading: true }));
  const flight: InFlight = { promise: undefined as unknown as Promise<void>, ac, waiters: 0 };
  const clearIfIdle = () => {
    const active = inflightMetrics.get(m);
    if (!active || active === flight) patchMachine(m, (cur) => ({ ...cur, metricsLoading: false }));
  };
  flight.promise = monitorApi
    .metrics(m, ac.signal)
    .then((metrics) => {
      if (ac.signal.aborted) {
        clearIfIdle();
        return;
      }
      patchMachine(m, (cur) => {
        const pt: HistoryPoint = {
          ts: metrics.timestampMs,
          cpu: metrics.cpu.usagePct,
          mem: metrics.memory.usedPct,
          gpu: peakGpuPct(metrics.gpus),
          rx: metrics.network.rxBytesPerSec,
          tx: metrics.network.txBytesPerSec,
        };
        const history = [...cur.history, pt].slice(-HISTORY_LIMIT);
        return { ...cur, metrics, history, metricsLoading: false, metricsError: undefined };
      });
    })
    .catch((err) => {
      if (ac.signal.aborted) {
        clearIfIdle();
        return;
      }
      patchMachine(m, (cur) => ({ ...cur, metricsLoading: false, metricsError: errorText(err) }));
    })
    .finally(() => {
      if (inflightMetrics.get(m) === flight) inflightMetrics.delete(m);
    });
  inflightMetrics.set(m, flight);
  return attachSignal(inflightMetrics, m, flight, signal);
}

/** Fetches one fresh process list for machine m (deduplicated in flight;
 * aborts the underlying request if every caller's signal aborts). */
export function fetchProcesses(m: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  const existing = inflightProcesses.get(m);
  if (existing) return attachSignal(inflightProcesses, m, existing, signal);
  const ac = new AbortController();
  patchMachine(m, (cur) => ({ ...cur, processesLoading: true }));
  const flight: InFlight = { promise: undefined as unknown as Promise<void>, ac, waiters: 0 };
  const clearIfIdle = () => {
    const active = inflightProcesses.get(m);
    if (!active || active === flight) patchMachine(m, (cur) => ({ ...cur, processesLoading: false }));
  };
  flight.promise = monitorApi
    .processes(m, ac.signal)
    .then((processes) => {
      if (ac.signal.aborted) {
        clearIfIdle();
        return;
      }
      patchMachine(m, (cur) => ({ ...cur, processes, processesLoading: false, processesError: undefined }));
    })
    .catch((err) => {
      if (ac.signal.aborted) {
        clearIfIdle();
        return;
      }
      patchMachine(m, (cur) => ({ ...cur, processesLoading: false, processesError: errorText(err) }));
    })
    .finally(() => {
      if (inflightProcesses.get(m) === flight) inflightProcesses.delete(m);
    });
  inflightProcesses.set(m, flight);
  return attachSignal(inflightProcesses, m, flight, signal);
}

/** Sends an allowlisted signal to a process and refreshes the process list. */
export async function sendProcessSignal(m: string, pid: number, sig: SignalName): Promise<void> {
  await monitorApi.signal(m, pid, sig);
  // Short delay so terminated processes exit before the next snapshot.
  setTimeout(() => void fetchProcesses(m), 250);
}

/** Shows the Task Manager panel for machine m. */
export function openTaskManagerFor(m: string) {
  useMonitor.getState().setTargetMachine(m);
  showPanel('monitor');
}

/** Opens the Task Manager as its own tab on machine m (used by new-tab menu
 * and the dashboard's Open in Pane button). */
export async function openTaskManagerTab(m: string) {
  useMonitor.getState().setTargetMachine(m);
  if (useStore.getState().panel === 'monitor') useStore.getState().setPanel(undefined);
  await actions.openView(m, { plugin: 'monitor', kind: PANEL_VIEW, panel: 'monitor' }, { tab: true, reuse: (v) => v.panel === 'monitor' });
}
