// Biometrics in the vault's page of Settings (SettingsExtra.tsx): what
// stands in for the passphrase (proof.ts: the desktop app's Touch ID or
// Windows Hello, WebAuthn credentials of browsers with PRF), which also
// unlocks the locked vault, the rule that every Allow needs it, and the
// apps exempt from asking. One added before unlock entries only approves
// until it is added again. The core shows them to a page with a session
// only: without one the page asks for the passphrase to unlock first.
// Changes need a session the passphrase opened (a page whose session a
// proof opened asks for the passphrase first), and adding an
// authenticator or an exemption the passphrase again with the request.
// The passphrase is asked beside the control whose change needs it, when
// that change is made, and dropped once it was sent: no field of the page
// holds it between changes.
import { useState, useEffect, type ReactNode } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { confirmDialog } from '../../dialog';
import { t } from '../../i18n';
import { useStore } from '../../state/store';
import { Picker } from '../../components/Picker';
import { noManager } from './fields';
import {
  addExemption,
  appOf,
  errorText,
  openSession,
  removeAuthenticator,
  removeExemption,
  setVerifyEachAllow,
  useVault,
  VaultError,
  type Authenticator,
  type VaultExemption,
} from './api';
import { localhostUrl, registerDesktop, registerWebAuthn, verifyUser, webauthnState } from './proof';
import { machineItems } from './shared';
import { useCanUnlock, wayName } from './useWay';

const day = (iso?: string) => (iso ? new Date(iso).toLocaleDateString() : '');

/** A change that waits for the passphrase, asked beside its control. */
interface Ask {
  at: 'desktop' | 'webauthn' | 'verify' | 'exempt';
  /** The button that makes the change. */
  confirm: string;
  /** That button's data-action. */
  action?: string;
  fn(pass: string): Promise<unknown>;
}

/** The field a passphrase for one change is typed into. */
function PassInput({
  value,
  onChange,
  focus,
  disabled,
}: {
  value: string;
  onChange(v: string): void;
  focus?: boolean;
  disabled?: boolean;
}) {
  return (
    <input
      className="input"
      type="password"
      {...noManager}
      autoFocus={focus}
      data-field="guard-passphrase"
      placeholder={t('vault.passphrase')}
      aria-label={t('vault.passphrase')}
      disabled={disabled}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** The prompt the desktop app has (Touch ID, Windows Hello), if any. */
function useDesktopPrompt(): 'touchid' | 'hello' | null {
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
  return prompt;
}

export function BiometricsSettings({ readOnly }: { readOnly: boolean }) {
  const status = useVault((s) => s.status);
  const guard = useVault((s) => s.guard);
  const session = useVault((s) => s.session);
  const sessionProof = useVault((s) => s.sessionProof);
  const prompt = useDesktopPrompt();
  const canUnlock = useCanUnlock();
  const [ask, setAsk] = useState<Ask>();
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [pass, setPass] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  if (!status || status.setup) return null;
  const askPass = !session || sessionProof;
  const off = readOnly || busy;

  /** Runs a change after a session the passphrase opened. The passphrase
   * typed for it is dropped whatever came of it. */
  const run = async (fn: () => Promise<unknown>, typed = '') => {
    setErr('');
    setBusy(true);
    try {
      // Adding takes the passphrase again in its body; the session is for
      // the route.
      if (askPass) await openSession(typed);
      await fn();
      return true;
    } catch (e) {
      setErr(e instanceof VaultError && e.code === 'vault_passphrase' ? t('vault.guard.needPassphrase') : errorText(e));
      return false;
    } finally {
      setBusy(false);
      setPass('');
    }
  };

  // Without a session (or while the core does not hold the key) the core
  // shows none of this: the passphrase unlocks it first.
  if (!guard?.full || !session)
    return (
      <div data-guard="">
        <h4 className="settings-group">{t('vault.guard.title')}</h4>
        <form
          className="setting-control row-gap"
          data-form="unlock"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {}, pass);
          }}
        >
          <PassInput value={pass} onChange={setPass} disabled={readOnly} />
          <button type="submit" className="primary" disabled={off || !pass}>
            {t('vault.unlock')}
          </button>
        </form>
        {err && <div className="callout error">{err}</div>}
      </div>
    );

  /** Ends whatever asks for the passphrase, and forgets what was typed. */
  const close = () => {
    setAsk(undefined);
    setAdding(false);
    setLabel('');
    setPass('');
    setErr('');
  };
  /** Makes a change: at once where the session is the passphrase's and the
   * change takes no passphrase of its own, else once it was typed beside
   * the control. */
  const change = (a: Ask, always = false) => {
    close();
    if (always || askPass) setAsk(a);
    else void run(() => a.fn(''));
  };
  const submitAsk = async () => {
    if (ask && (await run(() => ask.fn(pass), pass))) setAsk(undefined);
  };
  /** The passphrase asked for the change of the control at `at`. */
  const asking = (at: Ask['at']): ReactNode =>
    ask?.at === at && (
      <>
        <form
          className="setting-control row-gap"
          data-form="guard-ask"
          onSubmit={(e) => {
            e.preventDefault();
            void submitAsk();
          }}
        >
          <PassInput value={pass} onChange={setPass} focus disabled={readOnly} />
          <button type="button" onClick={close}>
            {t('dialog.cancel')}
          </button>
          <button className="primary" type="submit" data-action={ask.action ?? 'ask-confirm'} disabled={off || !pass}>
            {ask.confirm}
          </button>
        </form>
        {err && <div className="callout error">{err}</div>}
      </>
    );

  const state = webauthnState(guard);
  const alt = state === 'ip-host' ? localhostUrl() : null;
  // The desktop app's page has no WebAuthn (an IP address): browsers'
  // credentials are only listed there, to be removed.
  const inApp = !!verifyUser();
  const desktopOn = guard.authenticators.find((a) => a.kind === 'desktop');
  // The desktop authenticator is the switch where the app can prompt and
  // keep an unlock key, and listed elsewhere (a browser, an app without
  // the Secure Enclave or Windows Hello), so it can be removed there.
  const switchable = !!prompt && canUnlock;
  const listed = guard.authenticators.filter((a) => a.kind === 'webauthn' || !switchable);
  /** The note on one added before unlock entries: it only approves. */
  const approvalsOnly = (a?: Authenticator) =>
    a?.unlock === false && (
      <span className="muted" data-note="approvals-only">
        {t('vault.guard.approvalsOnly')}
      </span>
    );

  const addWebAuthn = async () => {
    const ok = await run(async () => {
      if (!(await registerWebAuthn(label.trim(), pass))) throw new VaultError('proof_cancelled');
    }, pass);
    if (ok) close();
  };

  const remove = async (a: Authenticator, at: Ask['at']) => {
    const ok = await confirmDialog({
      title: t('vault.guard.removeTitle'),
      message: t('vault.guard.removeMessage', { label: a.label }),
      confirm: t('vault.guard.remove'),
      danger: true,
    });
    if (ok) change({ at, confirm: t('vault.guard.remove'), fn: () => removeAuthenticator(a.id) });
  };

  return (
    <div data-guard="">
      <h4 className="settings-group">{t('vault.guard.title')}</h4>
      {switchable && prompt && (
        <div className="setting" data-switch="desktop">
          <label className="setting-check">
            <input
              type="checkbox"
              checked={!!desktopOn || ask?.action === 'desktop-confirm'}
              disabled={off}
              onChange={(e) => {
                if (!e.target.checked) {
                  if (desktopOn) void remove(desktopOn, 'desktop');
                  else close();
                  return;
                }
                // Turning it on takes the passphrase with the request.
                change(
                  {
                    at: 'desktop',
                    confirm: t('vault.guard.desktopOn', { way: wayName(prompt) }),
                    action: 'desktop-confirm',
                    fn: async (typed) => {
                      const added = await registerDesktop(t('vault.guard.desktopLabel', { way: wayName(prompt) }), typed);
                      if (!added) throw new VaultError('proof_cancelled');
                    },
                  },
                  true,
                );
              }}
            />
            <span>{t('vault.guard.desktop', { way: wayName(prompt) })}</span>
          </label>
          {desktopOn?.unlock === false && <div className="setting-desc">{approvalsOnly(desktopOn)}</div>}
          {asking('desktop')}
        </div>
      )}
      {(!inApp || listed.length > 0) && (
        <div className="setting" data-webauthn="">
          <div className="setting-head">
            <span className="setting-title">{t('vault.guard.webauthn')}</span>
          </div>
          {listed.length > 0 && (
            <ul className="vault-auths">
              {listed.map((a) => (
                <li key={a.id} data-auth={a.id}>
                  <span className="vault-auth-text">
                    <b>{a.label}</b>
                    <span className="muted">
                      {[
                        a.origin || a.rpId,
                        t('vault.guard.added', { date: day(a.created) }),
                        a.lastUsed && t('vault.guard.lastUsed', { date: day(a.lastUsed) }),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                    {approvalsOnly(a)}
                  </span>
                  <button
                    className="icon sm ghost"
                    data-action="remove-auth"
                    disabled={off}
                    title={t('vault.guard.remove')}
                    aria-label={t('vault.guard.remove')}
                    onClick={() => void remove(a, 'webauthn')}
                  >
                    <Trash2 />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {asking('webauthn')}
          {adding ? (
            <>
              <form
                className="setting-control row-gap"
                data-form="webauthn"
                onSubmit={(e) => {
                  e.preventDefault();
                  void addWebAuthn();
                }}
              >
                <input
                  className="input"
                  data-field="auth-label"
                  autoFocus
                  placeholder={t('vault.guard.label')}
                  aria-label={t('vault.guard.label')}
                  maxLength={64}
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                />
                <PassInput value={pass} onChange={setPass} disabled={readOnly} />
                <button type="button" onClick={close}>
                  {t('dialog.cancel')}
                </button>
                <button className="primary" type="submit" disabled={off || !label.trim() || !pass}>
                  {t('vault.guard.add')}
                </button>
              </form>
              {err && <div className="callout error">{err}</div>}
            </>
          ) : (
            state === 'ready' && (
              <div className="setting-control">
                <button
                  data-action="add-webauthn"
                  disabled={off}
                  onClick={() => {
                    close();
                    setAdding(true);
                  }}
                >
                  <Plus /> {t('vault.guard.addWebauthn')}
                </button>
              </div>
            )
          )}
          {state === 'ip-host' && !inApp && (
            <div className="setting-desc" data-note="ip-host">
              {t('vault.guard.ipHost')}{' '}
              {alt && (
                <a href={alt} data-link="localhost">
                  {t('vault.guard.useLocalhost')}
                </a>
              )}
            </div>
          )}
          {state === 'untrusted' && (
            <div className="setting-desc" data-note="untrusted">
              {t('vault.guard.untrusted')}
            </div>
          )}
          {state === 'unavailable' && <div className="setting-desc">{t('vault.guard.unavailable')}</div>}
        </div>
      )}
      <div className="setting" data-switch="verify">
        <div className="setting-head">
          <span className="setting-title">{t('vault.guard.verifyEach')}</span>
        </div>
        <label className="setting-check">
          <input
            type="checkbox"
            checked={guard.verifyEachAllow}
            disabled={off}
            onChange={(e) => {
              // Read now: the box is controlled, and shows the old state
              // again until the change was made. Ending the rule takes the
              // passphrase with the request.
              const on = e.target.checked;
              change({ at: 'verify', confirm: t('vault.save'), fn: (typed) => setVerifyEachAllow(on, on ? undefined : typed) }, !on);
            }}
          />
          <span>{t('vault.guard.verifyEachText')}</span>
        </label>
        {asking('verify')}
      </div>
      <Exemptions
        list={guard.exempt}
        disabled={off}
        run={run}
        onStart={close}
        onRemove={(id) => change({ at: 'exempt', confirm: t('vault.guard.remove'), fn: () => removeExemption(id) })}
        asking={asking('exempt')}
      />
      {err && !ask && !adding && <div className="callout error">{err}</div>}
    </div>
  );
}

/** The apps exempt from asking, by machine, and adding one: its name (the
 * apps seen asking on the machine are offered), the machines and the
 * passphrase, which an exemption takes with it. */
function Exemptions({
  list,
  disabled,
  run,
  onStart,
  onRemove,
  asking,
}: {
  list: VaultExemption[];
  disabled: boolean;
  run(fn: () => Promise<unknown>, typed?: string): Promise<boolean>;
  /** An exemption is being written: what else asked for the passphrase ends. */
  onStart(): void;
  onRemove(id: string): void;
  /** The passphrase asked for a removal, if one waits for it. */
  asking: ReactNode;
}) {
  const machines = useStore((s) => s.machines);
  const order = useStore((s) => s.order);
  const log = useVault((s) => s.log);
  const [app, setApp] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [pass, setPass] = useState('');
  const label = (m: string) => machines[m]?.label ?? m;
  // The apps that asked on the machines chosen (or any), as the core saw them.
  const seen = [...new Set(log.filter((a) => a.m && (!picked.length || picked.includes(a.m))).map((a) => appOf(a.process)))].filter(
    Boolean,
  );
  const name = app.trim();
  const drafting = !!name || picked.length > 0;
  useEffect(() => {
    if (drafting) onStart();
    else setPass('');
    // onStart is the page's own function, new with every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drafting]);
  const add = async () => {
    const typed = pass;
    setPass('');
    if (await run(() => addExemption(name, picked, typed), typed)) {
      setApp('');
      setPicked([]);
    }
  };
  return (
    <div className="setting" data-exempt="">
      <div className="setting-head">
        <span className="setting-title">{t('vault.exempt.title')}</span>
      </div>
      <div className="setting-desc">{t('vault.exempt.text')}</div>
      {list.length > 0 && (
        <ul className="vault-auths">
          {list.map((e) => (
            <li key={e.id} data-exemption={e.id}>
              <span className="vault-auth-text">
                <b>{t('vault.exempt.on', { app: e.app, machine: label(e.machine) })}</b>
                <span className="muted">{t('vault.guard.added', { date: day(e.created) })}</span>
              </span>
              <button
                className="icon sm ghost"
                data-action="remove-exempt"
                disabled={disabled}
                title={t('vault.guard.remove')}
                aria-label={t('vault.guard.remove')}
                onClick={() => onRemove(e.id)}
              >
                <Trash2 />
              </button>
            </li>
          ))}
        </ul>
      )}
      {asking}
      <form
        className="setting-control row-gap"
        data-form="exempt"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <input
          className="input"
          data-field="exempt-app"
          list="vault-exempt-apps"
          spellCheck={false}
          placeholder={t('vault.exempt.app')}
          aria-label={t('vault.exempt.app')}
          maxLength={64}
          value={app}
          onChange={(e) => setApp(e.target.value)}
        />
        <datalist id="vault-exempt-apps">
          {seen.map((a) => (
            <option key={a} value={a} />
          ))}
        </datalist>
        <Picker
          multiple
          className="vault-machines-picker"
          aria-label={t('vault.exempt.machines')}
          label={t('vault.exempt.machines')}
          noneLabel={t('vault.access.pickMachines')}
          items={machineItems(order, machines, picked)}
          value={picked}
          onChange={setPicked}
        />
        {drafting && <PassInput value={pass} onChange={setPass} disabled={disabled} />}
        <button type="submit" disabled={disabled || !name || !picked.length || !pass}>
          <Plus /> {t('vault.exempt.add')}
        </button>
      </form>
    </div>
  );
}
