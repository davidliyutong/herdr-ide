// The vault panel's access log: who asked for what and how it ended,
// filtered by machine and outcome, by day.
import { useState } from 'react';
import { History } from 'lucide-react';
import { useStore } from '../../state/store';
import { hasMessage, t } from '../../i18n';
import { processText, useVault, type VaultAccess } from './api';
import { Picker } from '../../components/Picker';

/** Outcomes: values let out (by the list, to an exempt app, or by a page:
 * a reveal, an export), approved by the user, refused, listed. */
const OUTCOME: Record<string, 'ok' | 'asked' | 'refused' | 'info'> = {
  allowed: 'ok',
  exempted: 'ok',
  injected: 'ok',
  revealed: 'ok',
  exported: 'ok',
  approved: 'asked',
  approved_always: 'asked',
  listed: 'info',
};

function resultText(result: string): string {
  const key = `vault.result.${result}`;
  return hasMessage(key) ? t(key) : result;
}

function toolText(tool: string): string {
  const key = `vault.tool.${tool}`;
  return hasMessage(key) ? t(key) : tool;
}

/** The machine filter's value of a page's records (machine ''). */
const PAGE = '\0page';

/** Who asked: the machine, the client and terminal it reported and the
 * directory; a page's address. */
function whoText(a: VaultAccess, label: (m: string) => string): string {
  if (!a.m) return [t('vault.log.page'), a.remote].filter(Boolean).join(' · ');
  return [
    label(a.m),
    a.client || t('vault.request.unknownClient'),
    a.terminal && t('vault.request.terminal', { terminal: a.terminal }),
    a.cwd,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** The accesses kept in the vault's access log, by day, filtered by
 * machine (or pages) and outcome. */
export function AccessLog() {
  const log = useVault((s) => s.log);
  const session = useVault((s) => s.session);
  const machines = useStore((s) => s.machines);
  const [machine, setMachine] = useState('');
  const [outcome, setOutcome] = useState('');
  const shown = log.filter(
    (a) => (!machine || (machine === PAGE ? !a.m : a.m === machine)) && (!outcome || (OUTCOME[a.result] ?? 'refused') === outcome),
  );
  const days = new Map<string, VaultAccess[]>();
  for (const a of shown.slice(0, 300)) {
    const d = new Date(a.time).toLocaleDateString();
    days.set(d, [...(days.get(d) ?? []), a]);
  }
  const ids = [...new Set(log.map((a) => a.m || PAGE))];
  const label = (m: string) => machines[m]?.label ?? m;
  return (
    <>
      <div className="vault-toolbar">
        <Picker
          aria-label={t('vault.log.machine')}
          label={t('vault.log.machine')}
          keepOrder
          items={[
            { value: '', label: t('vault.log.allMachines') },
            ...ids.map((m) => ({ value: m, label: m === PAGE ? t('vault.log.page') : label(m) })),
          ]}
          value={machine}
          onChange={setMachine}
        />
        <select value={outcome} aria-label={t('vault.log.outcome')} onChange={(e) => setOutcome(e.target.value)}>
          <option value="">{t('vault.log.allOutcomes')}</option>
          {(['ok', 'asked', 'refused', 'info'] as const).map((o) => (
            <option key={o} value={o}>
              {t(`vault.outcome.${o}`)}
            </option>
          ))}
        </select>
      </div>
      {!shown.length ? (
        <div className="empty-note">
          <History />
          {log.length ? t('vault.noMatch') : session ? t('vault.log.empty') : t('vault.log.needsSession')}
        </div>
      ) : (
        <div className="vault-log">
          {[...days].map(([day, list]) => (
            <section key={day}>
              <h4 className="section-head">{day}</h4>
              <ul>
                {list.map((a, i) => (
                  <li key={a.id ?? i} className={`vault-entry ${OUTCOME[a.result] ?? 'refused'}`} data-result={a.result}>
                    <span className="vault-entry-time mono">{new Date(a.time).toLocaleTimeString()}</span>
                    <span className="vault-entry-body">
                      <span className="vault-entry-line">
                        <span className={`vault-outcome ${OUTCOME[a.result] ?? 'refused'}`}>{resultText(a.result)}</span>
                        <span className="vault-entry-tool">{toolText(a.tool)}</span>
                        {(a.count ?? 1) > 1 && <span className="muted">{t('vault.log.count', { count: a.count ?? 1 })}</span>}
                      </span>
                      {(a.names ?? []).length > 0 && (
                        <span className="vault-entry-names">
                          {a.names!.map((n) => (
                            <code key={n}>{n}</code>
                          ))}
                        </span>
                      )}
                      <span className="vault-entry-who muted ellipsis" title={a.userAgent}>
                        {whoText(a, label)}
                      </span>
                      {(a.process ?? []).length > 0 && (
                        <span className="vault-entry-who vault-entry-process muted ellipsis" title={t('vault.log.process')}>
                          {processText(a.process)}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
