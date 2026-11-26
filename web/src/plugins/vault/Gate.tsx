// The vault panel's gate: creating the vault's passphrase, unlocking this
// page's session with it or with biometrics, or the session's bar with the
// lock. A lock forgets the vault's key: biometrics unlock a locked vault
// only by an unlock entry of theirs, and only within vault.passphraseDays
// of the passphrase (docs/features/30-variable-vault.md).
import { useEffect, useRef, useState } from 'react';
import { Fingerprint, Lock, LockOpen, Settings, ShieldCheck } from 'lucide-react';
import { useStore } from '../../state/store';
import { t } from '../../i18n';
import { settingValue } from '../../settings';
import { errorText, loadVault, lockVault, openSession, openSessionWithProof, setPassphrase, useVault, VaultError } from './api';
import { StrengthBar, noManager } from './fields';
import { prove, unlockWays, unlockWithDesktop, unlockWithPrf, ways } from './proof';
import { unlockWayName, useCanUnlock, useWayName } from './useWay';

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

/** Loads the vault again a moment after the auto-lock's time, should the
 * hub's word that it locked not reach this page. */
function useLockReload() {
  const lockAt = useVault((s) => (s.session ? s.autoLock?.lockAt : undefined));
  useEffect(() => {
    const at = lockAt ? Date.parse(lockAt) : NaN;
    if (Number.isNaN(at)) return;
    // setTimeout takes at most 2^31-1 ms.
    const id = setTimeout(() => void loadVault(), Math.min(Math.max(at - Date.now() + 1000, 1000), 2 ** 31 - 1));
    return () => clearTimeout(id);
  }, [lockAt]);
}

/** The vault's gate: a passphrase to create or to unlock this page's
 * session with; with a session, its bar. */
export function Gate() {
  const status = useVault((s) => s.status)!;
  const session = useVault((s) => s.session);
  const readOnly = useStore((s) => s.readOnly);
  const since = useSince();
  const [changing, setChanging] = useState(false);
  useLockReload();
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
          <button className="sm" onClick={() => void lockVault()}>
            <Lock /> {t('vault.lock')}
          </button>
          <SettingsButton />
        </span>
      </div>
      {changing && <PassphraseCard kind="change" onDone={() => setChanging(false)} />}
    </>
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

/** The days within which biometrics unlock after the passphrase (the
 * setting vault.passphraseDays), for the message that it is due. */
function passphraseDays(): number {
  const v = settingValue('vault.passphraseDays');
  return typeof v === 'number' && v > 0 ? v : 14;
}

/** Unlocking this page's session with the passphrase or biometrics: a
 * vault unlocked (another page's session) by an authenticator's proof; a
 * locked one by an unlock entry this page can use (the desktop app's key,
 * a credential's PRF), while the passphrase is not due. */
function UnlockCard() {
  const locked = useVault((s) => !!s.status?.locked);
  const guard = useVault((s) => s.guard);
  const unlock = useVault((s) => s.unlock);
  const since = useSince();
  const canUnlock = useCanUnlock();
  const w = ways(locked ? null : guard);
  const wayName = useWayName(w);
  const u = unlockWays(locked ? unlock : undefined, canUnlock);
  const byUnlock = !!u.desktop || u.prf;
  const byProof = !locked && (w.desktop || w.webauthn);
  const field = useRef<HTMLInputElement>(null);
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
  // An authenticator's proof opens a session of the unlocked vault.
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
  // An unlock entry unlocks the locked vault; a cancel says nothing.
  const withUnlock = async () => {
    setErr('');
    setBusy(true);
    try {
      await (u.desktop ? unlockWithDesktop() : unlockWithPrf());
    } catch (e) {
      const code = e instanceof VaultError ? e.code : '';
      if (code === 'passphrase_due') setErr(t('vault.gate.due', { days: passphraseDays() }));
      else if (code === 'unlock_stale') setErr(t('vault.gate.stale'));
      else setErr(errorText(e));
      if (code === 'passphrase_due' || code === 'unlock_stale') {
        field.current?.focus();
        // What the list offers changed with it.
        void loadVault();
      }
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
  const due = byUnlock && unlock?.due ? new Date(unlock.due) : undefined;
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
          ref={field}
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
        </div>
      )}
      {byUnlock && (
        <div className="vault-unlock-row">
          <button type="button" data-action="unlock-biometric" disabled={busy} onClick={() => void withUnlock()}>
            <Fingerprint /> {t('vault.gate.withProof', { way: unlockWayName(u) })}
          </button>
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
        </div>
      )}
      {due && !Number.isNaN(due.getTime()) && (
        <p className="vault-hint" data-note="due">
          {t('vault.gate.until', { date: due.toLocaleDateString() })}
        </p>
      )}
      {err && <div className="callout error">{err}</div>}
    </form>
  );
}
