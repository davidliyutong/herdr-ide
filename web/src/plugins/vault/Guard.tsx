// "Fingerprint and security keys": what stands in for the passphrase when
// the user approves a request (proof.ts), and the rule that every Allow
// needs it. Changes here need a session the passphrase opened: a page whose
// session is a proof's (or whose request the core refused with
// vault_passphrase) asks for the passphrase first.
import { useEffect, useState } from 'react';
import { Fingerprint, Plus, Trash2 } from 'lucide-react';
import { confirmDialog } from '../../dialog';
import { t } from '../../i18n';
import { noManager } from './fields';
import { errorText, openSession, removeAuthenticator, setVerifyEachAllow, useVault, VaultError, type Authenticator } from './api';
import { localhostUrl, registerDesktop, registerWebAuthn, verifyUser, webauthnState } from './proof';
import { wayName } from './useWay';
import './vault.css';

const day = (iso?: string) => (iso ? new Date(iso).toLocaleDateString() : '');

type Form = 'webauthn' | 'desktop';

export function GuardSection() {
  const guard = useVault((s) => s.guard);
  const session = useVault((s) => s.session);
  const sessionProof = useVault((s) => s.sessionProof);
  const [form, setForm] = useState<Form>();
  const [label, setLabel] = useState('');
  const [pass, setPass] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  // The prompt the desktop app has (Touch ID, Windows Hello), if any.
  const [prompt, setPrompt] = useState<'touchid' | 'hello' | null>(null);
  useEffect(() => {
    let live = true;
    void verifyUser()
      ?.available()
      .then(
        (a) => live && setPrompt(a),
        () => {},
      );
    return () => {
      live = false;
    };
  }, []);
  if (!guard) return null;
  const state = webauthnState();
  const alt = state === 'ip-host' ? localhostUrl() : null;
  const desktopOn = guard.authenticators.find((a) => a.kind === 'desktop');
  const askPass = !session || sessionProof;
  const showPass = askPass || form !== undefined;

  /** Runs a change after a session the passphrase opened. */
  const run = async (fn: () => Promise<unknown>) => {
    setErr('');
    setBusy(true);
    try {
      // Adding takes the passphrase again in its body; the session is for
      // the route.
      if (askPass) await openSession(pass);
      await fn();
      return true;
    } catch (e) {
      setErr(e instanceof VaultError && e.code === 'vault_passphrase' ? t('vault.guard.needPassphrase') : errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const submitForm = async () => {
    const ok = await run(async () => {
      const added =
        form === 'webauthn'
          ? await registerWebAuthn(label.trim(), pass)
          : await registerDesktop(t('vault.guard.desktopLabel', { way: wayName(prompt) }), pass);
      if (!added) throw new VaultError('proof_cancelled');
    });
    if (ok) {
      setForm(undefined);
      setLabel('');
      setPass('');
    }
  };

  const remove = async (a: Authenticator) => {
    const ok = await confirmDialog({
      title: t('vault.guard.removeTitle'),
      message: t('vault.guard.removeMessage', { label: a.label }),
      confirm: t('vault.guard.remove'),
      danger: true,
    });
    if (ok) await run(() => removeAuthenticator(a.id));
  };

  return (
    <details className="vault-guard" data-guard="">
      <summary>
        <Fingerprint /> {t('vault.guard.title')}
      </summary>
      <p className="vault-hint">{t('vault.guard.text')}</p>
      {guard.authenticators.length > 0 && (
        <ul className="vault-auths">
          {guard.authenticators.map((a) => (
            <li key={a.id} data-auth={a.id}>
              <span className="vault-auth-text">
                <b>{a.label}</b>
                <span className="muted">
                  {t(`vault.guard.kind.${a.kind}`)}
                  {a.rpId ? ` · ${a.rpId}` : ''} · {t('vault.guard.added', { date: day(a.created) })}
                  {a.lastUsed ? ` · ${t('vault.guard.lastUsed', { date: day(a.lastUsed) })}` : ''}
                </span>
              </span>
              <button
                className="sm ghost"
                data-action="remove-auth"
                disabled={busy || (askPass && !pass)}
                aria-label={t('vault.guard.remove')}
                onClick={() => void remove(a)}
              >
                <Trash2 />
              </button>
            </li>
          ))}
        </ul>
      )}
      {showPass && (
        <input
          className="input"
          type="password"
          {...noManager}
          data-field="guard-passphrase"
          placeholder={t('vault.guard.passphrase')}
          aria-label={t('vault.guard.passphrase')}
          value={pass}
          onChange={(e) => setPass(e.target.value)}
        />
      )}
      {form === 'webauthn' && (
        <form
          className="vault-auth-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submitForm();
          }}
        >
          <input
            className="input"
            data-field="auth-label"
            placeholder={t('vault.guard.label')}
            aria-label={t('vault.guard.label')}
            maxLength={64}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <div className="vault-gate-actions">
            <button type="button" onClick={() => setForm(undefined)}>
              {t('dialog.cancel')}
            </button>
            <button className="primary" type="submit" disabled={busy || !label.trim() || !pass}>
              {t('vault.guard.add')}
            </button>
          </div>
        </form>
      )}
      {form === 'desktop' && (
        <div className="vault-gate-actions">
          <button type="button" onClick={() => setForm(undefined)}>
            {t('dialog.cancel')}
          </button>
          <button className="primary" data-action="desktop-confirm" disabled={busy || !pass} onClick={() => void submitForm()}>
            {t('vault.guard.desktopOn', { way: wayName(prompt) })}
          </button>
        </div>
      )}
      {!form && state === 'ready' && (
        <button className="sm" data-action="add-webauthn" onClick={() => setForm('webauthn')}>
          <Plus /> {t('vault.guard.addWebauthn')}
        </button>
      )}
      {state === 'ip-host' && (
        <div className="vault-hint" data-note="ip-host">
          {t('vault.guard.ipHost')}{' '}
          {alt && (
            <a href={alt} data-link="localhost">
              {t('vault.guard.useLocalhost')}
            </a>
          )}
        </div>
      )}
      {state === 'unavailable' && <div className="vault-hint">{t('vault.guard.unavailable')}</div>}
      {prompt && (
        <label className="vault-check" data-switch="desktop">
          <input
            type="checkbox"
            checked={!!desktopOn || form === 'desktop'}
            disabled={busy || (askPass && !!desktopOn && !pass)}
            onChange={(e) => {
              if (!e.target.checked) {
                if (desktopOn) void remove(desktopOn);
                else setForm(undefined);
              } else setForm('desktop');
            }}
          />
          <span>{t('vault.guard.desktop', { way: wayName(prompt) })}</span>
        </label>
      )}
      <label className="vault-check" data-switch="verify">
        <input
          type="checkbox"
          checked={guard.verifyEachAllow}
          disabled={busy || (askPass && !pass)}
          onChange={(e) => {
            // Read now: the box is controlled, and shows the old state again
            // by the time a session has been opened.
            const on = e.target.checked;
            void run(() => setVerifyEachAllow(on));
          }}
        />
        <span>
          {t('vault.guard.verifyEach')}
          <span className="muted"> {t('vault.guard.verifyEachText')}</span>
        </span>
      </label>
      {err && <div className="callout error">{err}</div>}
    </details>
  );
}
