// The vault panel's gate: creating the vault's passphrase, unlocking this
// page's session with it or with biometrics, or the session's bar with the
// auto-lock's countdown and the lock.
import { useState } from 'react';
import { Fingerprint, Lock, LockOpen, Settings, ShieldCheck } from 'lucide-react';
import { useStore } from '../../state/store';
import { t } from '../../i18n';
import { errorText, lockVault, openSession, openSessionWithProof, setAutoLock, setPassphrase, useVault } from './api';
import { FreshPassphrase, StrengthBar, noManager } from './fields';
import { AutoLockButton } from './AutoLock';
import { prove, ways } from './proof';
import { useWayName } from './useWay';

/** When the passphrase was set, so that one the user did not choose shows
 * (on hover). */
function useSince(): string | undefined {
  const at = useVault((s) => s.status?.passphraseSet);
  return at ? t('vault.passphraseSince', { date: new Date(at).toLocaleString() }) : undefined;
}

/** Opens the vault's page in Settings, where biometrics are set. */
function SettingsButton() {
  return (
    <button
      type="button"
      className="icon sm ghost"
      data-action="vault-settings"
      title={t('settings.title')}
      aria-label={t('settings.title')}
      onClick={() => useStore.getState().openSettings({ page: 'vault' })}
    >
      <Settings />
    </button>
  );
}

/** The vault's gate: a passphrase to create or to unlock this page's
 * session with; with a session, its bar. */
export function Gate() {
  const status = useVault((s) => s.status)!;
  const session = useVault((s) => s.session);
  const readOnly = useStore((s) => s.readOnly);
  const since = useSince();
  const [changing, setChanging] = useState(false);
  // A longer automatic lock, waiting for the passphrase (undefined: none).
  const [longer, setLonger] = useState<number | null>();
  if (readOnly) {
    return (
      <div className="callout">
        <Lock />
        <span>{t('vault.readOnly')}</span>
      </div>
    );
  }
  if (status.setup) return <PassphraseCard kind="create" />;
  if (!session) return <UnlockCard />;
  return (
    <>
      <div className="vault-session">
        <LockOpen />
        <span className="vault-session-text" title={since}>
          <b>{t('vault.session.open')}</b>
        </span>
        <span className="vault-session-actions">
          <button className="sm ghost" onClick={() => setChanging(!changing)}>
            {t('vault.changePassphrase')}
          </button>
          <AutoLockButton onPassphrase={setLonger} />
          <button className="sm" onClick={() => void lockVault()}>
            <Lock /> {t('vault.lock')}
          </button>
          <SettingsButton />
        </span>
      </div>
      {longer !== undefined && <LongerLock minutes={longer} onDone={() => setLonger(undefined)} />}
      {changing && <PassphraseCard kind="change" onDone={() => setChanging(false)} />}
    </>
  );
}

/** The passphrase that lets the vault stay unlocked longer (or never lock
 * by itself) for this unlock: a session alone may not. */
function LongerLock({ minutes, onDone }: { minutes: number | null; onDone(): void }) {
  const [pass, setPass] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setErr('');
    setBusy(true);
    try {
      await setAutoLock(minutes, pass);
      onDone();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="vault-gate"
      data-fresh="autolock"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <FreshPassphrase value={pass} onChange={setPass} />
      {err && <div className="callout error">{err}</div>}
      <div className="vault-gate-actions">
        <button type="button" onClick={onDone}>
          {t('dialog.cancel')}
        </button>
        <button className="primary" type="submit" disabled={busy || !pass}>
          {t('vault.save')}
        </button>
      </div>
    </form>
  );
}

/** Creating the passphrase, or changing it. */
function PassphraseCard({ kind, onDone }: { kind: 'create' | 'change'; onDone?(): void }) {
  const guard = useVault((s) => s.guard);
  const [old, setOld] = useState('');
  const [pass, setPass] = useState('');
  const [repeat, setRepeat] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  // A new passphrase removes what was added with the old one.
  const resets = kind === 'change' && !!guard && (guard.authenticators.length > 0 || (guard.exempt?.length ?? 0) > 0);
  const submit = async () => {
    setErr('');
    if (pass !== repeat) return setErr(t('vault.error.mismatch'));
    setBusy(true);
    try {
      await setPassphrase(pass, kind === 'change' ? old : undefined);
      onDone?.();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="vault-gate"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="vault-gate-head">
        <ShieldCheck />
        <b>{t(`vault.gate.${kind}.title`)}</b>
      </div>
      {kind === 'change' && (
        <input
          className="input"
          type="password"
          {...noManager}
          placeholder={t('vault.passphraseCurrent')}
          aria-label={t('vault.passphraseCurrent')}
          value={old}
          onChange={(e) => setOld(e.target.value)}
        />
      )}
      <input
        className="input"
        type="password"
        {...noManager}
        autoFocus={kind !== 'change'}
        placeholder={t('vault.passphraseNew')}
        aria-label={t('vault.passphraseNew')}
        value={pass}
        onChange={(e) => setPass(e.target.value)}
      />
      <StrengthBar value={pass} />
      <input
        className="input"
        type="password"
        {...noManager}
        placeholder={t('vault.passphraseRepeat')}
        aria-label={t('vault.passphraseRepeat')}
        value={repeat}
        onChange={(e) => setRepeat(e.target.value)}
      />
      <p className="vault-hint">{t('vault.gate.hint')}</p>
      {resets && (
        <p className="vault-hint" data-note="resets">
          {t('vault.gate.change.resets')}
        </p>
      )}
      {err && <div className="callout error">{err}</div>}
      <div className="vault-gate-actions">
        {onDone && (
          <button type="button" onClick={onDone}>
            {t('dialog.cancel')}
          </button>
        )}
        <button className="primary" type="submit" disabled={busy || pass.length < 8 || !repeat || (kind === 'change' && !old)}>
          {t(`vault.gate.${kind}.button`)}
        </button>
      </div>
    </form>
  );
}

/** Unlocking this page's session with the passphrase, or with biometrics
 * while the core holds the key (the vault unlocked, or locked since the
 * passphrase was last given). */
function UnlockCard() {
  const locked = useVault((s) => s.status?.locked);
  const guard = useVault((s) => s.guard);
  const since = useSince();
  const w = ways(guard);
  const wayName = useWayName(w);
  const [pass, setPass] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setErr('');
    setBusy(true);
    try {
      await openSession(pass);
      setPass('');
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  // An authenticator's proof opens a session, and unlocks the vault while
  // the core holds the key.
  const withProof = async () => {
    setErr('');
    setBusy(true);
    try {
      const proof = await prove({ for: 'session' });
      if (proof) await openSessionWithProof(proof);
      else setErr(t('vault.proof.cancelled'));
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const forget = async () => {
    setErr('');
    try {
      await lockVault(true);
    } catch (e) {
      setErr(errorText(e));
    }
  };
  const byProof = w.desktop || w.webauthn;
  return (
    <form
      className="vault-gate"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="vault-gate-head">
        <Lock />
        <b title={since}>{t('vault.gate.unlock.title')}</b>
        <span className="spacer" />
        <SettingsButton />
      </div>
      <div className="vault-unlock-row">
        <input
          className="input"
          type="password"
          {...noManager}
          placeholder={t('vault.passphrase')}
          aria-label={t('vault.passphrase')}
          value={pass}
          onChange={(e) => setPass(e.target.value)}
        />
        <button className="primary" type="submit" disabled={busy || !pass}>
          {t('vault.unlock')}
        </button>
      </div>
      {byProof && (
        <div className="vault-unlock-row">
          <button type="button" data-action="proof-session" disabled={busy} onClick={() => void withProof()}>
            <Fingerprint /> {t('vault.gate.withProof', { way: wayName })}
          </button>
          {locked && (
            <button
              type="button"
              className="ghost"
              data-action="forget-key"
              title={t('vault.gate.forgetTitle')}
              disabled={busy}
              onClick={() => void forget()}
            >
              {t('vault.gate.forget')}
            </button>
          )}
        </div>
      )}
      {err && <div className="callout error">{err}</div>}
    </form>
  );
}
