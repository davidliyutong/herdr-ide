// The settings' Performance page, below its settings: what the app uses
// now (perf.ts), read every two seconds while the page is shown.

import { useEffect, useState } from 'react';
import { gpuName, megabytes, percent, sample, type Usage } from '../../perf';
import { t, type MessageKey } from '../../i18n';
import type { ProcessUsage } from '../../shell';

const EVERY_MS = 2000;

/** Electron's kinds of process in words; another kind goes by its own name. */
const kinds: Record<string, MessageKey> = {
  Browser: 'perf.process.shell',
  Tab: 'perf.process.page',
  GPU: 'perf.process.gpu',
  Utility: 'perf.process.helper',
};

const processName = (p: ProcessUsage) => {
  const kind = kinds[p.type] ? t(kinds[p.type]) : p.type;
  return p.name && p.type === 'Utility' ? `${kind} · ${p.name}` : kind;
};

export function Performance() {
  const [usage, setUsage] = useState<Usage>();
  useEffect(() => {
    let live = true;
    let last: Usage | undefined;
    const read = () =>
      void sample(last).then((u) => {
        last = u;
        if (live) setUsage(u);
      });
    read();
    const timer = window.setInterval(read, EVERY_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, []);
  if (!usage) return null;
  const { page, hub, hubCpu, processes } = usage;
  const gpu = gpuName();
  const none = '–';
  // Electron counts the processes together; the GPU's is the app's use of it.
  const total = processes?.reduce((a, p) => ({ cpu: a.cpu + p.cpu, memory: a.memory + p.memory }), { cpu: 0, memory: 0 });
  return (
    <>
      <h4 className="settings-group">{t('perf.usage')}</h4>
      <table className="perf-table">
        <thead>
          <tr>
            <th scope="col">{t('perf.part')}</th>
            <th scope="col">{t('perf.cpu')}</th>
            <th scope="col">{t('perf.memory')}</th>
          </tr>
        </thead>
        <tbody>
          {processes?.map((p, i) => (
            <tr key={i} data-kind={p.type}>
              <th scope="row">{processName(p)}</th>
              <td>{percent(p.cpu)}</td>
              <td>{megabytes(p.memory)}</td>
            </tr>
          ))}
          {!processes && (
            <tr data-kind="page">
              <th scope="row">{t('perf.process.page')}</th>
              <td>{none}</td>
              <td>{page.heap !== undefined ? megabytes(page.heap) : none}</td>
            </tr>
          )}
          <tr data-kind="hub">
            <th scope="row">{t('perf.process.core')}</th>
            <td>{hubCpu !== undefined ? percent(hubCpu) : none}</td>
            <td>{hub ? megabytes(hub.memory) : none}</td>
          </tr>
          {total && (
            <tr className="perf-total">
              <th scope="row">{t('perf.total')}</th>
              <td>{percent(total.cpu + (hubCpu ?? 0))}</td>
              <td>{megabytes(total.memory + (hub?.memory ?? 0))}</td>
            </tr>
          )}
        </tbody>
      </table>
      <p className="setting-desc">{t(processes ? 'perf.note.desktop' : 'perf.note.browser')}</p>
      <h4 className="settings-group">{t('perf.terminals')}</h4>
      <dl className="perf-facts">
        <dt>{t('perf.terminals.shown')}</dt>
        <dd>{page.shown}</dd>
        <dt>{t('perf.terminals.kept')}</dt>
        <dd>{page.kept}</dd>
        <dt>{t('perf.gpu')}</dt>
        <dd>{gpu || none}</dd>
        <dt>{t('perf.gpu.contexts')}</dt>
        <dd>{page.canvas ? t('perf.gpu.withCanvas', { webgl: page.webgl, canvas: page.canvas }) : page.webgl}</dd>
        {processes && page.heap !== undefined && (
          <>
            <dt>{t('perf.heap')}</dt>
            <dd>{megabytes(page.heap)}</dd>
          </>
        )}
      </dl>
    </>
  );
}
