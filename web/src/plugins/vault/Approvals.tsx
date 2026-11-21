// The vault's approval prompts, on every page: an MCP server on a machine
// not allowed to read a variable asks, and the first answer of any page
// wins; the others close the prompt when the core says it is resolved. No
// answer within the core's timeout is a denial. Allowing passes the gate:
// a page without a session proves it is the user, by an authenticator
// (biometrics: the app's prompt, a WebAuthn credential) when it has one,
// else with the passphrase, asked in the prompt itself; where the vault
// verifies every Allow a session is not enough either; denying needs
// nothing.
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Cpu, KeyRound, Terminal } from 'lucide-react';
import { useStore } from '../../state/store';
import { t } from '../../i18n';
import {
  answerRequest,
  dropRequest,
  errorText,
  loadRequests,
  openSession,
  processText,
  reloadVault,
  useVault,
  type Answer,
  VaultError,
  type VaultRequest,
} from './api';
import { prove, ways } from './proof';
import { useWayName } from './useWay';
import './vault.css';

/** The prompts (a status bar item of the plugin, drawn over the page). It
 * also loads the requests, and the vault, again whenever the page's
 * connection to the core comes back (after a restart of the core its
 * requests and sessions are gone and the vault is locked). */
export function VaultApprovals() {
  const requests = useVault((s) => s.requests);
  const connected = useStore((s) => s.connected);
  useEffect(() => void loadRequests(), []);
  useEffect(() => {
    if (connected) reloadVault();
  }, [connected]);
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

/** Seconds left before a request expires (a denial). */
function useLeft(expires: string): number {
  const end = Date.parse(expires);
  const [left, setLeft] = useState(() => Math.max(0, Math.round((end - Date.now()) / 1000)));
  useEffect(() => {
    const id = setInterval(() => setLeft(Math.max(0, Math.round((end - Date.now()) / 1000))), 1000);
    return () => clearInterval(id);
  }, [end]);
  return left;
}

export function RequestCard({ req }: { req: VaultRequest }) {
  const readOnly = useStore((s) => s.readOnly);
  const session = useVault((s) => s.session);
  const guard = useVault((s) => s.guard);
  const verify = !!guard?.verifyEachAllow;
  // A session alone allows, unless every Allow is verified.
  const oneClick = session && !verify;
  const w = ways(guard);
  const [usePass, setUsePass] = useState(false);
  const byProof = !oneClick && (w.desktop || w.webauthn) && !usePass;
  const needPass = !oneClick && !byProof;
  const wayName = useWayName(w);
  const [pass, setPass] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const left = useLeft(req.expires);
  const answer = async (a: Answer) => {
    setErr('');
    setBusy(true);
    try {
      if (a === 'deny' || oneClick) {
        await answerRequest(req.id, a);
      } else if (byProof) {
        const proof = await prove({ for: 'answer', request: req.id, answer: a });
        if (!proof) return setErr(t('vault.proof.cancelled'));
        await answerRequest(req.id, a, { proof });
      } else {
        // A page without a session opens one with the passphrase; only then
        // does the core say whether every Allow is verified, where the
        // passphrase comes with the answer too.
        if (!session) await openSession(pass);
        const ruled = !!useVault.getState().guard?.verifyEachAllow;
        await answerRequest(req.id, a, ruled ? { passphrase: pass } : undefined);
      }
    } catch (e) {
      // The request is gone (answered elsewhere or expired).
      if (e instanceof VaultError && e.code === 'not_found') dropRequest(req.id);
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="vault-request" role="alertdialog" aria-label={t('vault.request.title')} data-request={req.id}>
      <div className="vault-request-head">
        <KeyRound />
        <span className="vault-request-text">{requestText(req)}</span>
        <span className="vault-request-left muted">{left}s</span>
      </div>
      <div className="vault-request-names">
        {req.names.map((n) => (
          <code key={n}>{n}</code>
        ))}
      </div>
      {(req.terminal || req.cwd) && (
        <div className="vault-request-meta">
          <Terminal />
          {req.terminal && <span>{t('vault.request.terminal', { terminal: req.terminal })}</span>}
          {req.cwd && <span className="ellipsis">{req.cwd}</span>}
        </div>
      )}
      {(req.process ?? []).length > 0 && (
        <div className="vault-request-meta" data-meta="process" title={t('vault.log.process')}>
          <Cpu />
          <span className="ellipsis">{processText(req.process)}</span>
        </div>
      )}
      {readOnly ? (
        <div className="vault-request-meta">{t('vault.readOnly')}</div>
      ) : (
        <form
          className="vault-request-actions"
          onSubmit={(e) => {
            e.preventDefault();
            void answer('once');
          }}
        >
          {byProof && (
            <div className="vault-request-proof" data-proof="">
              <button type="button" className="sm ghost" data-action="use-passphrase" onClick={() => setUsePass(true)}>
                {t('vault.request.usePassphrase')}
              </button>
            </div>
          )}
          {needPass && (
            <input
              className="input"
              type="password"
              autoComplete="off"
              data-1p-ignore=""
              data-lpignore="true"
              data-bwignore=""
              data-form-type="other"
              placeholder={t('vault.request.passphrase')}
              aria-label={t('vault.request.passphrase')}
              value={pass}
              onChange={(e) => setPass(e.target.value)}
            />
          )}
          {needPass && (w.desktop || w.webauthn) && (
            <div className="vault-request-proof">
              <button type="button" className="sm ghost" data-action="use-proof" onClick={() => setUsePass(false)}>
                {t('vault.request.useProof', { way: wayName })}
              </button>
            </div>
          )}
          <div className="vault-request-buttons">
            <button type="button" className="ghost" data-answer="deny" disabled={busy} onClick={() => void answer('deny')}>
              {t('vault.deny')}
            </button>
            <span className="spacer" />
            <button type="button" data-answer="always" disabled={busy || (needPass && !pass)} onClick={() => void answer('always')}>
              {t('vault.allowAlways')}
            </button>
            <button type="submit" className="primary" data-answer="once" disabled={busy || (needPass && !pass)}>
              {t('vault.allowOnce')}
            </button>
          </div>
          {err && <div className="callout error">{err}</div>}
        </form>
      )}
    </div>
  );
}
