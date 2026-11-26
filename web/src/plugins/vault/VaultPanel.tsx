// The variable vault's panel in the right sidebar. At the top, the gate
// (Gate.tsx): creating the vault's passphrase, unlocking this page's
// session with it or with biometrics, or the session's bar with the
// auto-lock's countdown and the lock (biometrics are set in the vault's
// page of Settings: Biometrics.tsx). Then requests waiting for an answer
// and three tabs: the
// variables (Variables.tsx: never their values, except one revealed on
// request; an editor in a dialog), the access log (AccessLog.tsx: filtered
// by machine and outcome, by day) and how to connect a coding agent's CLI
// on each machine (SetupGuide.tsx).
import { useEffect, useState } from 'react';
import { History, Plug, Variable as VariableIcon } from 'lucide-react';
import { t } from '../../i18n';
import { loadErrorText, loadRequests, loadVault, useVault } from './api';
import { RequestCard } from './Approvals';
import { Gate } from './Gate';
import { Variables } from './Variables';
import { AccessLog } from './AccessLog';
import { SetupGuide } from './SetupGuide';

export { passStrength } from './fields';
import './vault.css';

type Tab = 'variables' | 'log' | 'connect';

/** Why the vault did not load (its file of another version or unreadable,
 * the hub unreachable), with a retry: a file moved away or put back is
 * opened at the next load. */
function LoadError({ code }: { code: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="callout error vault-load-error" role="alert" data-error={code}>
      <span>{loadErrorText(code)}</span>
      <button
        className="sm"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void Promise.all([loadVault(), loadRequests()]).finally(() => setBusy(false));
        }}
      >
        {t('vault.retry')}
      </button>
    </div>
  );
}

export function VaultPanel() {
  const { status, variables, error, requests, session } = useVault();
  const [tab, setTab] = useState<Tab>('variables');
  useEffect(() => {
    void loadVault();
    void loadRequests();
  }, []);
  if (error === 'unavailable') return <div className="empty-note">{t('vault.unavailable')}</div>;
  if (!status) return error ? <LoadError code={error} /> : null;
  const pending = Object.values(requests);
  return (
    <div className="vault">
      {error && <LoadError code={error} />}
      <Gate />
      {pending.length > 0 && (
        <section className="vault-pending" aria-label={t('vault.requests')}>
          {pending.map((r) => (
            <RequestCard key={r.id} req={r} />
          ))}
        </section>
      )}
      {(status.mode === 'passphrase' || variables.length > 0) && (
        <>
          <div className="segmented vault-tabs" role="tablist">
            {(
              [
                ['variables', VariableIcon, t('vault.tab.variables', { n: variables.length })],
                ['log', History, t('vault.tab.log')],
                ['connect', Plug, t('vault.tab.connect')],
              ] as const
            ).map(([id, Icon, label]) => (
              <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
                <Icon /> {label}
              </button>
            ))}
          </div>
          {tab === 'variables' && <Variables session={session} />}
          {tab === 'log' && <AccessLog />}
          {tab === 'connect' && <SetupGuide />}
        </>
      )}
    </div>
  );
}
