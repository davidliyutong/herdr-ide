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

const inflightMetrics = new Map<string, Promise<void>>();
const inflightProcesses = new Map<string, Promise<void>>();

function patchMachine(m: string, fn: (cur: MachineMonitorState) => MachineMonitorState) {
  useMonitor.setState((s) => ({
    machines: { ...s.machines, [m]: fn(s.machines[m] ?? emptyMachine()) },
  }));
}

/** Fetches one fresh metrics snapshot for machine m (deduplicated in flight). */
export function fetchMetrics(m: string): Promise<void> {
  const existing = inflightMetrics.get(m);
  if (existing) return existing;
  patchMachine(m, (cur) => ({ ...cur, metricsLoading: true }));
  const p = monitorApi
    .metrics(m)
    .then((metrics) => {
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
      patchMachine(m, (cur) => ({ ...cur, metricsLoading: false, metricsError: errorText(err) }));
    })
    .finally(() => {
      inflightMetrics.delete(m);
    });
  inflightMetrics.set(m, p);
  return p;
}

/** Fetches one fresh process list for machine m (deduplicated in flight). */
export function fetchProcesses(m: string): Promise<void> {
  const existing = inflightProcesses.get(m);
  if (existing) return existing;
  patchMachine(m, (cur) => ({ ...cur, processesLoading: true }));
  const p = monitorApi
    .processes(m)
    .then((processes) => {
      patchMachine(m, (cur) => ({ ...cur, processes, processesLoading: false, processesError: undefined }));
    })
    .catch((err) => {
      patchMachine(m, (cur) => ({ ...cur, processesLoading: false, processesError: errorText(err) }));
    })
    .finally(() => {
      inflightProcesses.delete(m);
    });
  inflightProcesses.set(m, p);
  return p;
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
