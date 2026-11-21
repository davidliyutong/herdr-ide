// Shared resource dashboard card rendered in both:
//  1) the Cmd+hover popover beside a machine in the left sidebar
//  2) the upward-floating status bar popover at the bottom right
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Cpu,
  HardDrive,
  ListTree,
  MemoryStick,
  Network,
  RefreshCw,
  SquareArrowOutUpLeft,
} from 'lucide-react';
import { t, type MessageKey } from '../../i18n';
import { useStore } from '../../state/store';
import type { DiskMetric, GPUMetric, Metrics } from './api';
import { formatBytes, formatPct, formatRate, formatUptime, metricLevel } from './model';
import { fetchMetrics, openTaskManagerFor, openTaskManagerTab, useMonitor, type HistoryPoint } from './state';

interface Props {
  machineId: string;
  onClose?: () => void;
}

export function DashboardCard({ machineId, onClose }: Props) {
  const machine = useStore((s) => s.machines[machineId]);
  const readOnly = useStore((s) => s.readOnly);
  const st = useMonitor((s) => s.machines[machineId]);
  const metrics = st?.metrics;
  const history = st?.history ?? [];

  if (!machine) {
    return (
      <div className="monitor-card" data-machine={machineId}>
        <div className="muted small">{t('monitor.noMachine')}</div>
      </div>
    );
  }

  const ready = machine.status === 'ready';

  return (
    <div className="monitor-card" data-machine={machineId}>
      <div className="monitor-card-head">
        <span className={`mstatus ms-${machine.status}`} />
        <div className="monitor-card-title">
          <div className="monitor-card-name ellipsis">{machine.label}</div>
          <div className="monitor-card-sub muted ellipsis">
            {[
              metrics ? `${metrics.os}/${metrics.arch}` : machine.platform,
              metrics?.uptimeSec ? t('monitor.uptime', { time: formatUptime(metrics.uptimeSec) }) : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </div>
        </div>
        <div className="monitor-card-actions">
          {ready && (
            <button
              className="icon"
              title={t('monitor.refresh')}
              aria-label={t('monitor.refresh')}
              onClick={() => void fetchMetrics(machineId)}
            >
              <RefreshCw className={st?.metricsLoading ? 'monitor-spin' : undefined} />
            </button>
          )}
          {ready && (
            <button
              className="sm monitor-tm-btn"
              title={t('monitor.openTaskManager')}
              onClick={() => {
                onClose?.();
                openTaskManagerFor(machineId);
              }}
            >
              <ListTree />
              <span>{t('monitor.openTaskManager')}</span>
            </button>
          )}
          {ready && !readOnly && (
            <button
              className="icon"
              title={t('monitor.openInPane')}
              aria-label={t('monitor.openInPane')}
              onClick={() => {
                onClose?.();
                void openTaskManagerTab(machineId);
              }}
            >
              <SquareArrowOutUpLeft />
            </button>
          )}
        </div>
      </div>

      {!ready ? (
        <div className="monitor-card-empty muted">{t('monitor.offline', { status: t(`machine.${machine.status}` as MessageKey) })}</div>
      ) : !metrics ? (
        <div className="monitor-card-empty muted">{st?.metricsError || t('monitor.loading')}</div>
      ) : (
        <MetricsBody metrics={metrics} history={history} error={st?.metricsError} />
      )}
    </div>
  );
}

function MetricsBody({ metrics, history, error }: { metrics: Metrics; history: readonly HistoryPoint[]; error?: string }) {
  const cpuLevel = metricLevel(metrics.cpu.usagePct);
  const memLevel = metricLevel(metrics.memory.usedPct);
  const hasSwap = metrics.memory.swapTotalBytes > 0;
  const swapPct = hasSwap ? (metrics.memory.swapUsedBytes / metrics.memory.swapTotalBytes) * 100 : 0;

  return (
    <div className="monitor-sections">
      {error && <div className="monitor-error small">{error}</div>}

      {/* CPU */}
      <section className="monitor-sec">
        <div className="monitor-sec-head">
          <span className="monitor-sec-label">
            <Cpu />
            <span>{t('monitor.cpu')}</span>
          </span>
          <span className="muted monitor-sec-meta">{t('monitor.cores', { n: metrics.cpu.cores })}</span>
          <span className={`monitor-sec-val level-${cpuLevel}`}>{formatPct(metrics.cpu.usagePct)}</span>
        </div>
        <div className="monitor-bar-row">
          <Meter pct={metrics.cpu.usagePct} color="var(--ds-chart-blue)" level={cpuLevel} />
          {history.length >= 2 && <Sparkline values={history.map((h) => h.cpu)} color="var(--ds-chart-blue)" />}
        </div>
        <div className="monitor-subline muted">
          {t('monitor.load', {
            l1: metrics.cpu.load1.toFixed(1),
            l5: metrics.cpu.load5.toFixed(1),
            l15: metrics.cpu.load15.toFixed(1),
          })}
        </div>
      </section>

      {/* Memory */}
      <section className="monitor-sec">
        <div className="monitor-sec-head">
          <span className="monitor-sec-label">
            <MemoryStick />
            <span>{t('monitor.memory')}</span>
          </span>
          <span className="muted monitor-sec-meta">
            {formatBytes(metrics.memory.usedBytes)} / {formatBytes(metrics.memory.totalBytes)}
          </span>
          <span className={`monitor-sec-val level-${memLevel}`}>{formatPct(metrics.memory.usedPct)}</span>
        </div>
        <div className="monitor-bar-row">
          <Meter pct={metrics.memory.usedPct} color="var(--ds-chart-purple)" level={memLevel} />
          {history.length >= 2 && <Sparkline values={history.map((h) => h.mem)} color="var(--ds-chart-purple)" />}
        </div>
        <div className="monitor-subline muted">
          <span>{t('monitor.avail', { size: formatBytes(metrics.memory.availableBytes) })}</span>
          {hasSwap && (
            <span className="monitor-swap">
              {t('monitor.swap')} {formatBytes(metrics.memory.swapUsedBytes)} / {formatBytes(metrics.memory.swapTotalBytes)} (
              {formatPct(swapPct)})
            </span>
          )}
        </div>
      </section>

      {/* GPU (per item) */}
      <section className="monitor-sec">
        <div className="monitor-sec-head">
          <span className="monitor-sec-label">
            <Activity />
            <span>{metrics.gpus.length > 0 ? t('monitor.gpuCount', { n: metrics.gpus.length }) : t('monitor.gpu')}</span>
          </span>
          {metrics.gpus.length === 0 && <span className="muted monitor-sec-meta">{t('monitor.gpuNone')}</span>}
        </div>
        {metrics.gpus.length > 0 && (
          <div className="monitor-gpu-list">
            {metrics.gpus.map((g) => (
              <GpuRow key={g.index} gpu={g} />
            ))}
          </div>
        )}
      </section>

      {/* Network */}
      <section className="monitor-sec">
        <div className="monitor-sec-head">
          <span className="monitor-sec-label">
            <Network />
            <span>{t('monitor.network')}</span>
          </span>
          <span className="monitor-net-rates">
            <span className="monitor-net-rx" title={t('monitor.netRx')}>
              <ArrowDown />
              {formatRate(metrics.network.rxBytesPerSec)}
            </span>
            <span className="monitor-net-tx" title={t('monitor.netTx')}>
              <ArrowUp />
              {formatRate(metrics.network.txBytesPerSec)}
            </span>
          </span>
        </div>
        <div className="monitor-subline muted">
          <span>
            {t('monitor.netTotal', {
              rx: formatBytes(metrics.network.rxBytes),
              tx: formatBytes(metrics.network.txBytes),
            })}
          </span>
        </div>
        {metrics.network.interfaces && metrics.network.interfaces.length > 1 && (
          <div className="monitor-ifaces">
            {metrics.network.interfaces.slice(0, 3).map((ni) => (
              <div key={ni.name} className="monitor-iface muted">
                <span className="ellipsis">{ni.name}</span>
                <span className="monitor-nums">
                  ↓ {formatRate(ni.rxBytesPerSec)} · ↑ {formatRate(ni.txBytesPerSec)}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Disk */}
      <section className="monitor-sec">
        <div className="monitor-sec-head">
          <span className="monitor-sec-label">
            <HardDrive />
            <span>{t('monitor.disk')}</span>
          </span>
          <span className="muted monitor-sec-meta monitor-nums">
            {t('monitor.diskIO', {
              r: formatRate(metrics.diskIO.readBytesPerSec),
              w: formatRate(metrics.diskIO.writeBytesPerSec),
            })}
          </span>
        </div>
        {metrics.disks.length > 0 && (
          <div className="monitor-disk-list">
            {metrics.disks.slice(0, 5).map((d) => (
              <DiskRow key={d.mount} disk={d} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function GpuRow({ gpu }: { gpu: GPUMetric }) {
  const utilLevel = gpu.utilPct !== undefined ? metricLevel(gpu.utilPct) : 'ok';
  const memLevel = gpu.memPct !== undefined ? metricLevel(gpu.memPct) : 'ok';
  return (
    <div className="monitor-gpu-item" data-gpu={gpu.index}>
      <div className="monitor-gpu-head">
        <span className="monitor-gpu-idx">#{gpu.index}</span>
        <span className="monitor-gpu-name ellipsis" title={gpu.name}>
          {gpu.name}
        </span>
        {gpu.tempC !== undefined && <span className="monitor-chip">{Math.round(gpu.tempC)}°C</span>}
        {gpu.powerW !== undefined && (
          <span className="monitor-chip">
            {Math.round(gpu.powerW)}W{gpu.powerLimitW ? `/${Math.round(gpu.powerLimitW)}W` : ''}
          </span>
        )}
      </div>
      {gpu.utilPct !== undefined && (
        <div className="monitor-gpu-metric">
          <span className="muted">{t('monitor.gpuUtil')}</span>
          <Meter pct={gpu.utilPct} color="var(--ds-chart-green)" level={utilLevel} small />
          <span className={`monitor-nums level-${utilLevel}`}>{formatPct(gpu.utilPct)}</span>
        </div>
      )}
      {gpu.memTotalBytes ? (
        <div className="monitor-gpu-metric">
          <span className="muted">{t('monitor.gpuVram')}</span>
          <Meter pct={gpu.memPct ?? 0} color="var(--ds-chart-teal)" level={memLevel} small />
          <span className={`monitor-nums level-${memLevel}`}>
            {formatBytes(gpu.memUsedBytes ?? 0)} / {formatBytes(gpu.memTotalBytes)}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function DiskRow({ disk }: { disk: DiskMetric }) {
  const level = metricLevel(disk.usedPct);
  return (
    <div className="monitor-disk-item">
      <div className="monitor-disk-line">
        <span className="monitor-disk-mount ellipsis" title={`${disk.mount} (${disk.device})`}>
          {disk.mount}
        </span>
        <span className="muted monitor-nums">
          {formatBytes(disk.usedBytes)} / {formatBytes(disk.totalBytes)}
        </span>
        <span className={`monitor-nums monitor-disk-pct level-${level}`}>{formatPct(disk.usedPct)}</span>
      </div>
      <Meter pct={disk.usedPct} color="var(--ds-chart-cyan)" level={level} small />
    </div>
  );
}

function Meter({ pct, color, level, small }: { pct: number; color: string; level: string; small?: boolean }) {
  const clamped = Math.max(0, Math.min(100, pct));
  const fillColor = level === 'hot' ? 'var(--error)' : level === 'warn' ? 'var(--warning)' : color;
  return (
    <div className={`monitor-meter ${small ? 'small' : ''}`}>
      <i style={{ width: `${clamped}%`, background: fillColor }} />
    </div>
  );
}

function Sparkline({ values, color }: { values: readonly number[]; color: string }) {
  const w = 52;
  const h = 14;
  const n = values.length;
  const pts = values
    .map((v, i) => {
      const x = n === 1 ? w : (i / (n - 1)) * w;
      const y = h - (Math.max(0, Math.min(100, v)) / 100) * (h - 2) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg className="monitor-spark" viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <polyline fill="none" stroke={color} strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" points={pts} />
    </svg>
  );
}
