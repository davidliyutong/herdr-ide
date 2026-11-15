// The vault's approval prompts, on every page: an MCP server on a machine
// not allowed to read a variable asks, and the first answer of any page
// wins; the others close the prompt when the core says it is resolved. No
// answer within the core's timeout is a denial.
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { KeyRound } from 'lucide-react';
import { useStore } from '../../state/store';
import { t } from '../../i18n';
import { answerRequest, loadRequests, useVault, type VaultRequest } from './api';
import './vault.css';

/** The prompts (a status bar item of the plugin, drawn over the page). */
export function VaultApprovals() {
  const requests = useVault((s) => s.requests);
  useEffect(() => void loadRequests(), []);
  const list = Object.values(requests).sort((a, b) => a.created.localeCompare(b.created));
  if (!list.length) return null;
  return createPortal(
    <div className="vault-approvals" role="region" aria-label={t('vault.requests')}>
      {list.map((r) => (
        <RequestCard key={r.id} req={r} />
      ))}
    </div>,
    document.body,
  );
}

export function requestText(r: VaultRequest): string {
  const machine = useStore.getState().machines[r.m]?.label ?? r.m;
  return t(r.tool === 'env' ? 'vault.request.env' : 'vault.request.get', {
    client: r.client || t('vault.request.unknownClient'),
    machine,
    names: r.names.join(', '),
  });
}

export function RequestCard({ req }: { req: VaultRequest }) {
  const readOnly = useStore((s) => s.readOnly);
  return (
    <div className="vault-request" role="alertdialog" aria-label={t('vault.request.title')} data-request={req.id}>
      <div className="vault-request-head">
        <KeyRound />
        <span>{requestText(req)}</span>
      </div>
      {(req.terminal || req.cwd) && (
        <div className="vault-request-meta">
          {req.terminal && <span>{t('vault.request.terminal', { terminal: req.terminal })}</span>}
          {req.cwd && <span className="ellipsis">{req.cwd}</span>}
        </div>
      )}
      {readOnly ? (
        <div className="vault-request-meta">{t('vault.readOnly')}</div>
      ) : (
        <div className="vault-request-actions">
          <button data-answer="deny" onClick={() => void answerRequest(req.id, 'deny')}>
            {t('vault.deny')}
          </button>
          <button data-answer="always" onClick={() => void answerRequest(req.id, 'always')}>
            {t('vault.allowAlways')}
          </button>
          <button className="primary" data-answer="once" onClick={() => void answerRequest(req.id, 'once')}>
            {t('vault.allowOnce')}
          </button>
        </div>
      )}
    </div>
  );
}
