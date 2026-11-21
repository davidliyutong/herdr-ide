// @vitest-environment jsdom
//
// The vault's authenticators in the page (plugins/vault/proof.ts, the
// request card, the gate, the biometrics of the vault's settings page):
// which proofs a page can make, how it makes them (WebAuthn, the desktop
// app's prompt), the card's choices between a click, a proof and the
// passphrase, unlocking with a proof, and the settings' changes, which need
// a session the passphrase opened.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import { useStore } from '../state/store';
import { useDialog } from '../dialog';
import { t } from '../i18n';
import { VaultPanel } from '../plugins/vault/VaultPanel';
import { VaultSettingsExtra } from '../plugins/vault/SettingsExtra';
import { RequestCard } from '../plugins/vault/Approvals';
import {
  endSession,
  openSession,
  useVault,
  type Authenticator,
  type VaultGuard,
  type VaultGuardFull,
  type VaultRequest,
  type VaultVariable,
} from '../plugins/vault/api';
import { b64urlDecode, b64urlEncode, localhostUrl, prove, ways, webauthnState } from '../plugins/vault/proof';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PASS = 'right passphrase';
const PASS_TOKEN = 'tok-pass';
const PROOF_TOKEN = 'tok-proof';
const NONCE = b64urlEncode(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
const CRED = b64urlEncode(new Uint8Array([9, 9, 9]));

interface Call {
  method: string;
  url: string;
  token?: string;
  body?: any;
}

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const type = (el: HTMLInputElement, v: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

const auth = (over: Partial<Authenticator> = {}): Authenticator => ({
  id: 'a1',
  kind: 'webauthn' as const,
  label: 'Laptop',
  origin: location.origin,
  rpId: 'localhost',
  created: '2026-03-01T00:00:00Z',
  lastUsed: '2026-03-05T00:00:00Z',
  ...over,
});
const guardOf = (over: Partial<VaultGuardFull> = {}): VaultGuardFull => ({
  full: true,
  authenticators: [],
  verifyEachAllow: false,
  desktop: false,
  webauthn: true,
  exempt: [],
  ...over,
});

/** The guard as the core shows it to a page without a session. */
const waysOf = (g: VaultGuardFull): VaultGuard => ({
  authenticators: g.authenticators
    .filter((a) => (a.kind === 'desktop' ? g.desktop : g.webauthn && a.origin === location.origin))
    .map((a) => (a.kind === 'desktop' ? { kind: a.kind } : { kind: a.kind, origin: a.origin })),
  desktop: g.desktop,
  webauthn: g.webauthn,
});

const REQ: VaultRequest = {
  id: 'r1',
  m: 'gpu',
  tool: 'get',
  names: ['GH'],
  created: '',
  expires: new Date(Date.now() + 60_000).toISOString(),
};

/** What the authenticator makes of a request for an assertion. */
const assertion = () => ({
  rawId: new Uint8Array([9, 9, 9]).buffer,
  response: {
    clientDataJSON: new Uint8Array([1]).buffer,
    authenticatorData: new Uint8Array([2]).buffer,
    signature: new Uint8Array([3]).buffer,
  },
});

describe('vault authenticators', () => {
  let host: HTMLDivElement;
  let root: Root;
  let calls: Call[];
  /** What guards the vault, as the core keeps it (null: the key not held). */
  let guard: VaultGuardFull | null;
  let creds: string[];
  let desktopUsable: boolean;
  let refuseProof: boolean;
  let variables: VaultVariable[];
  // The core's rule, which the page may not know yet.
  let serverRule: boolean;
  // The vault is locked, the core holding its key or not (guard null).
  let locked: boolean;
  let get: ReturnType<typeof vi.fn>;
  let create: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    calls = [];
    guard = guardOf();
    creds = [];
    desktopUsable = false;
    refuseProof = false;
    variables = [];
    serverRule = false;
    locked = false;
    get = vi.fn(async () => assertion());
    create = vi.fn(async () => ({
      rawId: new Uint8Array([9, 9, 9]).buffer,
      response: {
        clientDataJSON: new Uint8Array([4]).buffer,
        getAuthenticatorData: () => new Uint8Array([5]).buffer,
        getPublicKey: () => new Uint8Array([6]).buffer,
        getPublicKeyAlgorithm: () => -7,
      },
    }));
    vi.stubGlobal('PublicKeyCredential', class {});
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    Object.defineProperty(navigator, 'credentials', { value: { get, create }, configurable: true });
    delete (globalThis as { desktopShell?: unknown }).desktopShell;
    await endSession().catch(() => undefined);
    useVault.setState({
      status: undefined,
      variables: [],
      log: [],
      requests: {},
      error: undefined,
      session: false,
      sessionProof: false,
      guard: undefined,
    });
    useStore.setState({ readOnly: false, connected: false, machines: { m1: { label: 'gpu' } } as never, order: ['m1'] });
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const token = headers['X-Vault-Session'];
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, token, body });
      const json = (v: unknown, code = 200) => new Response(JSON.stringify(v), { status: code });
      const open = token === PASS_TOKEN || token === PROOF_TOKEN;
      if (url === '/api/p/vault' && method === 'GET')
        return json({
          status: { mode: 'passphrase', locked },
          session: open,
          sessionProof: token === PROOF_TOKEN,
          idle: 600,
          variables,
          // Without a session, only the ways this page can prove with.
          guard: open || !guard ? guard : waysOf(guard),
        });
      if (url === '/api/p/vault/log')
        return json({
          log: [
            {
              time: '2026-03-05T00:00:00Z',
              m: 'm1',
              tool: 'get',
              result: 'denied',
              process: [
                { pid: 2, name: 'mcp' },
                { pid: 1, name: 'codex' },
              ],
            },
          ],
        });
      if (url === '/api/p/vault/lock') {
        locked = true;
        if (body?.forget) guard = null;
        return json({ mode: 'passphrase', locked: true });
      }
      if (url === '/api/p/vault/requests') return json({ requests: [] });
      if (url === '/api/p/vault/proof')
        return json({ nonce: NONCE, rpId: 'localhost', credentials: creds, desktop: desktopUsable, ttl: 120 });
      if (url === '/api/p/vault/session' && method === 'POST') {
        if (body.proof) {
          // A proof unlocks a vault whose key the core holds, and no other.
          if (!guard) return json({ error: 'vault_locked' }, 409);
          locked = false;
          return json({ session: PROOF_TOKEN, proof: true, status: { mode: 'passphrase', locked: false } });
        }
        if (body.passphrase !== PASS) return json({ error: 'wrong_passphrase' }, 403);
        locked = false;
        guard ??= guardOf();
        return json({ session: PASS_TOKEN, status: { mode: 'passphrase', locked: false } });
      }
      if (url.startsWith('/api/p/vault/vars/')) {
        const name = decodeURIComponent(url.split('/')[5]);
        const rule = serverRule || !!guard?.verifyEachAllow;
        const widening = method === 'PUT' && body.injectOnly === false;
        if ((url.endsWith('/reveal') || widening) && rule) {
          if (body?.proof && refuseProof) return json({ error: 'vault_proof' }, 401);
          if (body?.passphrase && body.passphrase !== PASS) return json({ error: 'wrong_passphrase' }, 403);
          if (!body?.proof && !body?.passphrase) return json({ error: 'vault_proof' }, 401);
        }
        return url.endsWith('/reveal') ? json({ value: 'secret-' + name }) : json({ name, machines: [], injectOnly: body.injectOnly });
      }
      if (url.startsWith('/api/p/vault/requests/')) {
        if (body.proof && refuseProof) return json({ error: 'vault_proof' }, 401);
        if (guard?.verifyEachAllow && !body.proof && !body.passphrase && body.answer !== 'deny') return json({ error: 'vault_proof' }, 401);
        return json({ ok: true });
      }
      // What guards the vault takes a session the passphrase opened.
      if (token === PROOF_TOKEN) return json({ error: 'vault_passphrase' }, 401);
      if (!open) return json({ error: 'vault_session' }, 401);
      if (url === '/api/p/vault/authenticators' && method === 'POST') {
        guard = { ...guard!, authenticators: [...guard!.authenticators, auth({ id: 'new', kind: body.kind, label: body.label })] };
        return json({ guard });
      }
      if (url.startsWith('/api/p/vault/authenticators/') && method === 'DELETE') {
        guard = { ...guard!, authenticators: guard!.authenticators.filter((a) => a.id !== url.split('/').pop()) };
        return json({ guard });
      }
      if (url === '/api/p/vault/exempt' && method === 'POST') {
        if (!body.passphrase) return json({ error: 'passphrase_required' }, 403);
        if (body.passphrase !== PASS) return json({ error: 'wrong_passphrase' }, 403);
        const added = body.machines.map((m: string) => ({
          id: `${body.app}@${m}`,
          machine: m,
          app: body.app,
          created: '2026-03-06T00:00:00Z',
        }));
        guard = { ...guard!, exempt: [...guard!.exempt, ...added] };
        return json({ guard });
      }
      if (url.startsWith('/api/p/vault/exempt/') && method === 'DELETE') {
        guard = { ...guard!, exempt: guard!.exempt.filter((e) => e.id !== decodeURIComponent(url.split('/').pop()!)) };
        return json({ guard });
      }
      if (url === '/api/p/vault/guard') {
        // Ending the rule takes the passphrase.
        if (!body.verifyEachAllow && guard?.verifyEachAllow && body.passphrase !== PASS) return json({ error: 'wrong_passphrase' }, 403);
        guard = { ...guard!, verifyEachAllow: body.verifyEachAllow };
        return json({ guard });
      }
      return json({ error: 'not_found' }, 404);
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    delete (navigator as { credentials?: unknown }).credentials;
    delete (globalThis as { desktopShell?: unknown }).desktopShell;
  });

  const shell = (prompt: 'touchid' | 'hello' | null, mac: string | null) => {
    const prove = vi.fn(async () => mac);
    (globalThis as { desktopShell?: unknown }).desktopShell = { verifyUser: { available: async () => prompt, prove } };
    return prove;
  };
  const unlock = async () => {
    await act(async () => type(host.querySelector<HTMLInputElement>(`.vault-gate input[aria-label="${t('vault.passphrase')}"]`)!, PASS));
    await act(async () => host.querySelector<HTMLButtonElement>('.vault-gate button[type="submit"]')!.click());
    await flush();
  };
  const renderPanel = async () => {
    await act(async () => root.render(createElement(VaultPanel)));
    await flush();
  };
  const renderSettings = async () => {
    await act(async () => root.render(createElement(VaultSettingsExtra, { readOnly: false })));
    await flush();
  };
  /** A session the passphrase opened, as the panel's gate opens it. */
  const passSession = async () => {
    await act(async () => openSession(PASS));
    await flush();
  };
  const renderCard = async () => {
    await act(async () => root.render(createElement(RequestCard, { req: REQ })));
    await flush();
  };
  const click = async (sel: string) => {
    await act(async () => host.querySelector<HTMLElement>(sel)!.click());
    await flush();
  };
  const answerCall = () => calls.find((c) => c.url === '/api/p/vault/requests/r1');

  describe('ways', () => {
    it('base64url without padding round-trips', () => {
      expect(b64urlEncode(new Uint8Array([251, 255, 254]))).toBe('-__-');
      expect(b64urlEncode(new Uint8Array([1, 2]))).toBe('AQI');
      expect([...b64urlDecode('-__-')]).toEqual([251, 255, 254]);
      expect([...b64urlDecode('AQI')]).toEqual([1, 2]);
      expect(b64urlEncode(b64urlDecode(NONCE).buffer)).toBe(NONCE);
    });

    it('offers what the guard, the host and the shell allow', () => {
      const web = guardOf({ authenticators: [auth()] });
      expect(ways(web)).toEqual({ desktop: false, webauthn: true });
      // A credential of another host is of no use here.
      expect(ways(guardOf({ authenticators: [auth({ rpId: 'other.example', origin: 'https://other.example' })] })).webauthn).toBe(false);
      // The same host name from another origin (another port or scheme) is not this page's.
      expect(ways(guardOf({ authenticators: [auth({ origin: 'http://localhost:1' })] })).webauthn).toBe(false);
      expect(ways(guardOf({ authenticators: [auth({ origin: undefined })] })).webauthn).toBe(false);
      // The core does not vouch for this origin.
      expect(ways(guardOf({ authenticators: [auth()], webauthn: false })).webauthn).toBe(false);
      expect(ways(null)).toEqual({ desktop: false, webauthn: false });
      const desk = guardOf({ authenticators: [auth({ kind: 'desktop', rpId: undefined })], desktop: true });
      // The guard has it but the page is no desktop app.
      expect(ways(desk).desktop).toBe(false);
      shell('touchid', 'aa');
      expect(ways(desk)).toEqual({ desktop: true, webauthn: false });
      expect(ways({ ...desk, desktop: false }).desktop).toBe(false);
      expect(ways({ ...desk, authenticators: [] }).desktop).toBe(false);
      expect(ways(guardOf({ authenticators: [...desk.authenticators, auth()], desktop: true }))).toEqual({ desktop: true, webauthn: true });
    });

    it('knows an IP host and an insecure page, and the localhost address of a loopback one', () => {
      expect(webauthnState(guardOf())).toBe('ready');
      // On a name the core does not vouch for: a note, no adding.
      expect(webauthnState(guardOf({ webauthn: false }))).toBe('untrusted');
      expect(webauthnState(null)).toBe('untrusted');
      Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
      expect(webauthnState(guardOf())).toBe('unavailable');
      Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
      vi.stubGlobal('location', { hostname: '127.0.0.1', port: '8080', pathname: '/x', search: '?a=1' });
      expect(webauthnState(guardOf())).toBe('ip-host');
      expect(localhostUrl()).toBe('http://localhost:8080/x?a=1');
      expect(ways(guardOf({ authenticators: [auth({ rpId: '127.0.0.1' })] })).webauthn).toBe(false);
      expect(webauthnState(guardOf())).toBe('ip-host');
      vi.stubGlobal('location', { hostname: '192.168.1.5', port: '8080', pathname: '/', search: '' });
      expect(webauthnState(guardOf())).toBe('ip-host');
      expect(localhostUrl()).toBeNull();
    });
  });

  describe('prove', () => {
    it('asks WebAuthn for the nonce as the challenge, of this host’s credentials', async () => {
      creds = [CRED];
      const proof = await prove({ for: 'answer', request: 'r1', answer: 'once' });
      expect(calls[0]).toMatchObject({ url: '/api/p/vault/proof', body: { for: 'answer', request: 'r1', answer: 'once' } });
      const opts = get.mock.calls[0][0].publicKey;
      expect([...new Uint8Array(opts.challenge)]).toEqual([...b64urlDecode(NONCE)]);
      expect(opts).toMatchObject({ rpId: 'localhost', userVerification: 'required', timeout: 120_000 });
      expect(opts.allowCredentials).toHaveLength(1);
      expect([...new Uint8Array(opts.allowCredentials[0].id)]).toEqual([9, 9, 9]);
      expect(opts.allowCredentials[0].type).toBe('public-key');
      expect(proof).toEqual({ nonce: NONCE, credential: CRED, clientDataJSON: 'AQ', authenticatorData: 'Ag', signature: 'Aw' });
    });

    it('uses the desktop prompt when the app has it on', async () => {
      creds = [CRED];
      desktopUsable = true;
      const p = shell('touchid', 'ab12');
      expect(await prove({ for: 'session' })).toEqual({ nonce: NONCE, mac: 'ab12' });
      expect(p).toHaveBeenCalledWith(NONCE);
      expect(get).not.toHaveBeenCalled();
    });

    it('gives null when the user cancelled', async () => {
      creds = [CRED];
      get.mockRejectedValueOnce(new DOMException('no', 'NotAllowedError'));
      expect(await prove({ for: 'session' })).toBeNull();
      desktopUsable = true;
      shell('hello', null);
      expect(await prove({ for: 'session' })).toBeNull();
    });
  });

  describe('the request card', () => {
    const ctl = () => ({
      once: host.querySelector<HTMLButtonElement>('[data-answer="once"]')!,
      field: host.querySelector<HTMLInputElement>('.vault-request input[type="password"]'),
    });

    it('answers with one click while a session is open and nothing is verified', async () => {
      useVault.setState({ session: true, guard: guardOf({ authenticators: [auth()] }) });
      useVault.setState({ requests: { r1: REQ } });
      await renderCard();
      expect(ctl().field).toBeNull();
      await click('[data-answer="once"]');
      expect(answerCall()?.body).toEqual({ answer: 'once' });
      expect(calls.some((c) => c.url.endsWith('/proof'))).toBe(false);
    });

    it('proves, without a passphrase field, when there is no session', async () => {
      creds = [CRED];
      useVault.setState({ guard: guardOf({ authenticators: [auth()] }), requests: { r1: REQ } });
      await renderCard();
      expect(ctl().field).toBeNull();
      await click('[data-answer="always"]');
      expect(calls.find((c) => c.url.endsWith('/proof'))?.body).toEqual({ for: 'answer', request: 'r1', answer: 'always' });
      expect(answerCall()?.body).toMatchObject({ answer: 'always', proof: { nonce: NONCE, credential: CRED } });
      expect(useVault.getState().requests.r1).toBeUndefined();
    });

    it('swaps in the passphrase field on the link, which opens a session', async () => {
      useVault.setState({ guard: guardOf({ authenticators: [auth()] }), requests: { r1: REQ } });
      await renderCard();
      await click('[data-action="use-passphrase"]');
      expect(ctl().once.disabled).toBe(true);
      await act(async () => type(ctl().field!, PASS));
      await click('[data-answer="once"]');
      expect(calls.map((c) => c.url)).toContain('/api/p/vault/session');
      expect(answerCall()?.body).toEqual({ answer: 'once' });
      expect(calls.some((c) => c.url.endsWith('/proof'))).toBe(false);
    });

    it('with every Allow verified, uses a proof over the session', async () => {
      creds = [CRED];
      useVault.setState({ session: true, guard: guardOf({ authenticators: [auth()], verifyEachAllow: true }), requests: { r1: REQ } });
      await renderCard();
      expect(ctl().field).toBeNull();
      await click('[data-answer="once"]');
      expect(answerCall()?.body.proof).toBeDefined();
    });

    it('with every Allow verified and no authenticator, sends the passphrase with the answer', async () => {
      useVault.setState({ session: true, guard: guardOf({ verifyEachAllow: true }), requests: { r1: REQ } });
      await renderCard();
      await act(async () => type(ctl().field!, PASS));
      await click('[data-answer="once"]');
      expect(answerCall()?.body).toEqual({ answer: 'once', passphrase: PASS });
      expect(calls.some((c) => c.url === '/api/p/vault/session')).toBe(false);
    });

    it('keeps the card and says so when the proof is cancelled or refused', async () => {
      creds = [CRED];
      useVault.setState({ guard: guardOf({ authenticators: [auth()] }), requests: { r1: REQ } });
      await renderCard();
      get.mockRejectedValueOnce(new DOMException('no', 'NotAllowedError'));
      await click('[data-answer="once"]');
      expect(host.querySelector('.callout.error')?.textContent).toBe(t('vault.proof.cancelled'));
      expect(answerCall()).toBeUndefined();
      refuseProof = true;
      await click('[data-answer="once"]');
      expect(host.querySelector('.callout.error')?.textContent).toBe(t('vault.error.vault_proof'));
      expect(useVault.getState().requests.r1).toBeDefined();
      expect(host.querySelector('[data-request="r1"]')).not.toBeNull();
    });

    it('without a session, opens one with the passphrase, then sends it with the answer where every Allow is verified', async () => {
      guard = guardOf({ verifyEachAllow: true });
      // What a page without a session knows: no way to prove, nor the rule.
      useVault.setState({ guard: waysOf(guard), requests: { r1: REQ } });
      await renderCard();
      await act(async () => type(ctl().field!, PASS));
      await click('[data-answer="once"]');
      expect(calls.map((c) => c.url)).toContain('/api/p/vault/session');
      expect(answerCall()?.body).toEqual({ answer: 'once', passphrase: PASS });
    });

    it('denies without anything', async () => {
      useVault.setState({ guard: guardOf({ verifyEachAllow: true }), requests: { r1: REQ } });
      await renderCard();
      await click('[data-answer="deny"]');
      expect(answerCall()?.body).toEqual({ answer: 'deny' });
    });
  });

  describe('the gate', () => {
    it('continues with biometrics where the page can prove, and the session is a proof’s', async () => {
      creds = [CRED];
      guard = guardOf({ authenticators: [auth()] });
      await renderPanel();
      await click('[data-action="proof-session"]');
      expect(calls.find((c) => c.url === '/api/p/vault/session')?.body.proof).toMatchObject({ nonce: NONCE, credential: CRED });
      expect(useVault.getState()).toMatchObject({ session: true, sessionProof: true });
    });

    it('unlocks a vault locked while the core holds its key with biometrics, or requires the passphrase', async () => {
      creds = [CRED];
      guard = guardOf({ authenticators: [auth()] });
      locked = true;
      await renderPanel();
      expect(host.querySelector('[data-action="proof-session"]')).not.toBeNull();
      await click('[data-action="proof-session"]');
      expect(useVault.getState()).toMatchObject({ session: true, status: { locked: false } });
      // Locked again: Require Passphrase has the core forget the key.
      await click('.vault-session button.sm:not(.ghost)');
      expect(calls.filter((c) => c.url === '/api/p/vault/lock').pop()?.body).toBeUndefined();
      expect(host.querySelector('[data-action="forget-key"]')).not.toBeNull();
      await click('[data-action="forget-key"]');
      expect(calls.filter((c) => c.url === '/api/p/vault/lock').pop()?.body).toEqual({ forget: true });
      // Now only the passphrase unlocks it.
      expect(useVault.getState().guard).toBeNull();
      expect(host.querySelector('[data-action="proof-session"]')).toBeNull();
      expect(host.querySelector('[data-action="forget-key"]')).toBeNull();
    });

    it('offers no proof, nor Require Passphrase, where the page cannot prove', async () => {
      guard = guardOf({ authenticators: [auth({ origin: 'http://localhost:1' })] });
      locked = true;
      await renderPanel();
      expect(host.querySelector('[data-action="proof-session"]')).toBeNull();
      expect(host.querySelector('[data-action="forget-key"]')).toBeNull();
    });
  });

  describe('the settings page', () => {
    const section = () => host.querySelector<HTMLElement>('[data-guard]');

    it('lists the authenticators and removes one after a confirmation', async () => {
      guard = guardOf({
        authenticators: [auth(), auth({ id: 'a2', kind: 'desktop', rpId: undefined, origin: undefined, label: 'This app' })],
      });
      await renderSettings();
      await passSession();
      // In a browser the desktop app's authenticator is listed, to be removed.
      const rows = [...section()!.querySelectorAll<HTMLElement>('[data-auth]')];
      expect(rows.map((r) => r.dataset.auth)).toEqual(['a1', 'a2']);
      expect(rows[0].textContent).toContain('Laptop');
      expect(rows[0].textContent).toContain(location.origin);
      expect(section()!.textContent).toContain(t('vault.guard.title'));
      await click('[data-auth="a1"] [data-action="remove-auth"]');
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
      const dlg = useDialog.getState().current;
      expect(dlg?.kind).toBe('confirm');
      await act(async () => {
        if (dlg?.kind === 'confirm') dlg.resolve(true);
      });
      await flush();
      expect(calls.find((c) => c.method === 'DELETE')).toMatchObject({ url: '/api/p/vault/authenticators/a1', token: PASS_TOKEN });
      expect([...section()!.querySelectorAll<HTMLElement>('[data-auth]')].map((r) => r.dataset.auth)).toEqual(['a2']);
    });

    it('adds a WebAuthn credential: it is created, then signs the same nonce', async () => {
      creds = [CRED];
      await renderSettings();
      await passSession();
      await click('[data-action="add-webauthn"]');
      await act(async () => type(host.querySelector<HTMLInputElement>('[data-field="auth-label"]')!, 'Phone'));
      await act(async () => type(host.querySelector<HTMLInputElement>('[data-field="guard-passphrase"]')!, PASS));
      await act(async () => host.querySelector<HTMLButtonElement>('[data-form="webauthn"] button[type="submit"]')!.click());
      await flush();
      const o = create.mock.calls[0][0].publicKey;
      expect([...new Uint8Array(o.challenge)]).toEqual([...b64urlDecode(NONCE)]);
      expect(o).toMatchObject({
        rp: { id: 'localhost', name: 'herdr-ide' },
        attestation: 'none',
        authenticatorSelection: { userVerification: 'required', residentKey: 'discouraged' },
      });
      expect(o.user.id).toHaveLength(16);
      expect(o.pubKeyCredParams.map((p: { alg: number }) => p.alg)).toEqual([-7, -8, -257]);
      expect(o.excludeCredentials).toHaveLength(1);
      const g = get.mock.calls[0][0].publicKey;
      expect([...new Uint8Array(g.challenge)]).toEqual([...b64urlDecode(NONCE)]);
      expect(g.allowCredentials).toHaveLength(1);
      expect(calls.find((c) => c.url.endsWith('/proof'))?.body).toEqual({ for: 'register' });
      expect(calls.find((c) => c.url.endsWith('/authenticators'))?.body).toEqual({
        kind: 'webauthn',
        label: 'Phone',
        passphrase: PASS,
        nonce: NONCE,
        clientDataJSON: 'BA',
        authenticatorData: 'BQ',
        publicKey: 'Bg',
        alg: -7,
        assertion: { nonce: NONCE, credential: CRED, clientDataJSON: 'AQ', authenticatorData: 'Ag', signature: 'Aw' },
      });
      expect(section()!.querySelector('[data-auth="new"]')).not.toBeNull();
    });

    it('offers localhost on a loopback IP, instead of adding', async () => {
      vi.stubGlobal('location', { hostname: '127.0.0.1', port: '9000', pathname: '/', search: '' });
      await renderSettings();
      await passSession();
      expect(section()!.querySelector('[data-action="add-webauthn"]')).toBeNull();
      expect(section()!.querySelector<HTMLAnchorElement>('[data-link="localhost"]')?.getAttribute('href')).toBe('http://localhost:9000/');
    });

    it('turns the desktop authenticator on with the prompt’s MAC and the passphrase', async () => {
      shell('touchid', 'cafe');
      guard = guardOf({ desktop: true });
      await renderSettings();
      await passSession();
      const sw = section()!.querySelector<HTMLInputElement>('[data-switch="desktop"] input')!;
      expect(section()!.textContent).toContain(t('vault.guard.desktop', { way: t('vault.way.touchid') }));
      await act(async () => sw.click());
      await act(async () => type(host.querySelector<HTMLInputElement>('[data-field="guard-passphrase"]')!, PASS));
      await click('[data-action="desktop-confirm"]');
      expect(calls.find((c) => c.url.endsWith('/authenticators'))?.body).toEqual({
        kind: 'desktop',
        label: t('vault.guard.desktopLabel', { way: t('vault.way.touchid') }),
        passphrase: PASS,
        nonce: NONCE,
        mac: 'cafe',
      });
      expect(section()!.querySelector<HTMLInputElement>('[data-switch="desktop"] input')!.checked).toBe(true);
      // The switch stands for it: it is not listed again, and the app's page,
      // which has no WebAuthn, shows nothing of browsers without credentials.
      expect(section()!.querySelector('[data-auth]')).toBeNull();
      expect(section()!.querySelector('[data-webauthn]')).toBeNull();
    });

    it('shows no desktop switch in a browser', async () => {
      await renderSettings();
      await passSession();
      expect(section()!.querySelector('[data-switch="desktop"]')).toBeNull();
    });

    it('sets the rule that every Allow is verified', async () => {
      await renderSettings();
      await passSession();
      await click('[data-switch="verify"] input');
      expect(calls.find((c) => c.url.endsWith('/guard'))).toMatchObject({
        method: 'POST',
        token: PASS_TOKEN,
        body: { verifyEachAllow: true },
      });
      expect(section()!.querySelector<HTMLInputElement>('[data-switch="verify"] input')!.checked).toBe(true);
    });

    it('asks for the passphrase before a change in a session that biometrics opened', async () => {
      creds = [CRED];
      guard = guardOf({ authenticators: [auth()] });
      await act(async () =>
        root.render(createElement('div', null, createElement(VaultPanel), createElement(VaultSettingsExtra, { readOnly: false }))),
      );
      await flush();
      await click('[data-action="proof-session"]');
      expect(useVault.getState()).toMatchObject({ session: true, sessionProof: true });
      const box = () => section()!.querySelector<HTMLInputElement>('[data-switch="verify"] input')!;
      const field = () => host.querySelector<HTMLInputElement>('[data-field="guard-passphrase"]');
      // No field holds a passphrase until a change is made: it is asked
      // beside the control then.
      expect(field()).toBeNull();
      expect(box().disabled).toBe(false);
      await click('[data-switch="verify"] input');
      expect(calls.some((c) => c.url.endsWith('/guard'))).toBe(false);
      expect(section()!.querySelector('[data-switch="verify"] [data-form="guard-ask"]')).not.toBeNull();
      await act(async () => type(field()!, PASS));
      await click('[data-action="ask-confirm"]');
      expect(field()).toBeNull();
      const urls = calls.map((c) => `${c.method} ${c.url}`);
      expect(urls.indexOf('POST /api/p/vault/session', urls.indexOf('POST /api/p/vault/session') + 1)).toBeGreaterThan(-1);
      expect(calls.find((c) => c.url.endsWith('/guard'))).toMatchObject({ token: PASS_TOKEN, body: { verifyEachAllow: true } });
      expect(useVault.getState().sessionProof).toBe(false);
    });

    it('shows the origin of a credential and offers adding only where the core vouches for the page', async () => {
      guard = guardOf({ authenticators: [auth(), auth({ id: 'a2', origin: 'http://localhost:1', label: 'Other port' })] });
      await renderSettings();
      await passSession();
      const rows = [...section()!.querySelectorAll<HTMLElement>('[data-auth]')];
      expect(rows[0].textContent).toContain(location.origin);
      expect(rows[1].textContent).toContain('http://localhost:1');
      expect(section()!.querySelector('[data-action="add-webauthn"]')).not.toBeNull();
      expect(section()!.querySelector('[data-note="untrusted"]')).toBeNull();
      guard = { ...guard!, webauthn: false };
      await act(async () => void (await import('../plugins/vault/api')).loadVault());
      await flush();
      expect(section()!.querySelector('[data-action="add-webauthn"]')).toBeNull();
      expect(section()!.querySelector('[data-note="untrusted"]')?.textContent).toBe(t('vault.guard.untrusted'));
    });

    it('ending the rule asks for the passphrase and sends it; turning it on needs none', async () => {
      guard = guardOf({ verifyEachAllow: true });
      await renderSettings();
      await passSession();
      const box = () => section()!.querySelector<HTMLInputElement>('[data-switch="verify"] input')!;
      const field = () => host.querySelector<HTMLInputElement>('[data-field="guard-passphrase"]');
      // The rule being on puts no passphrase field on the page.
      expect(field()).toBeNull();
      await click('[data-switch="verify"] input');
      expect(calls.some((c) => c.url.endsWith('/guard'))).toBe(false);
      expect(box().checked).toBe(true);
      // Asked beside the switch; Cancel leaves the rule and takes the field.
      const asked = () => section()!.querySelector('[data-switch="verify"] [data-form="guard-ask"]');
      expect(asked()).not.toBeNull();
      expect(asked()!.querySelector<HTMLButtonElement>('[data-action="ask-confirm"]')!.disabled).toBe(true);
      await act(async () => type(field()!, 'typed and left'));
      await act(async () => asked()!.querySelector<HTMLButtonElement>('button[type="button"]')!.click());
      expect(field()).toBeNull();
      expect(calls.some((c) => c.url.endsWith('/guard'))).toBe(false);
      await click('[data-switch="verify"] input');
      // What was typed before is not kept.
      expect(field()!.value).toBe('');
      await act(async () => type(field()!, 'wrong one'));
      await click('[data-action="ask-confirm"]');
      await flush();
      expect(section()!.querySelector('.callout.error')?.textContent).toBe(t('vault.error.wrong_passphrase'));
      expect(field()!.value).toBe('');
      expect(box().checked).toBe(true);
      await act(async () => type(field()!, PASS));
      await click('[data-action="ask-confirm"]');
      expect(calls.filter((c) => c.url.endsWith('/guard')).pop()?.body).toEqual({ verifyEachAllow: false, passphrase: PASS });
      expect(box().checked).toBe(false);
      expect(field()).toBeNull();
      await click('[data-switch="verify"] input');
      expect(calls.filter((c) => c.url.endsWith('/guard')).pop()?.body).toEqual({ verifyEachAllow: true });
      expect(field()).toBeNull();
    });

    it('exempts an app on the machines chosen, offering the apps seen asking there, and ends it', async () => {
      await renderSettings();
      await passSession();
      const form = () => host.querySelector<HTMLFormElement>('[data-form="exempt"]')!;
      expect([...form().querySelectorAll('datalist option')].map((o) => o.getAttribute('value'))).toEqual(['codex']);
      await act(async () => type(form().querySelector<HTMLInputElement>('[data-field="exempt-app"]')!, ' claude '));
      expect(form().querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
      await act(async () => form().querySelector<HTMLButtonElement>('.vault-machines-picker')!.click());
      await act(async () => document.querySelector<HTMLElement>('.picker-row')!.click());
      await act(async () =>
        document
          .querySelector<HTMLInputElement>('.picker-search')!
          .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
      );
      // The passphrase comes with an exemption, also in a session of the
      // passphrase: its field shows once one is being written.
      const field = () => host.querySelector<HTMLInputElement>('[data-field="guard-passphrase"]');
      expect(field()).not.toBeNull();
      expect(form().contains(field())).toBe(true);
      expect(form().querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
      await act(async () => type(field()!, 'wrong one'));
      await act(async () => form().querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
      await flush();
      expect(section()!.querySelector('.callout.error')?.textContent).toBe(t('vault.error.wrong_passphrase'));
      expect(field()!.value).toBe('');
      await act(async () => type(field()!, PASS));
      await act(async () => form().querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
      await flush();
      expect(calls.filter((c) => c.url === '/api/p/vault/exempt').pop()).toMatchObject({
        token: PASS_TOKEN,
        body: { app: 'claude', machines: ['m1'], passphrase: PASS },
      });
      // Added, the field goes, and the passphrase with it.
      expect(field()).toBeNull();
      const row = section()!.querySelector<HTMLElement>('[data-exemption="claude@m1"]')!;
      expect(row.textContent).toContain(t('vault.exempt.on', { app: 'claude', machine: 'gpu' }));
      await act(async () => row.querySelector<HTMLButtonElement>('[data-action="remove-exempt"]')!.click());
      await flush();
      expect(calls.find((c) => c.method === 'DELETE')).toMatchObject({ url: '/api/p/vault/exempt/claude%40m1', token: PASS_TOKEN });
      expect(section()!.querySelector('[data-exemption]')).toBeNull();
    });

    it('shows nothing of what guards the vault to a page without a session', async () => {
      creds = [CRED];
      guard = guardOf({
        authenticators: [auth()],
        verifyEachAllow: true,
        exempt: [{ id: 'e1', machine: 'm1', app: 'claude', created: '' }],
      });
      await renderSettings();
      // The core held the key, but the page has no session: unlock first.
      expect(useVault.getState().guard).toEqual({
        authenticators: [{ kind: 'webauthn', origin: location.origin }],
        desktop: false,
        webauthn: true,
      });
      expect(section()!.querySelector('[data-form="unlock"]')).not.toBeNull();
      expect(section()!.querySelector('[data-exemption], [data-auth], [data-switch="verify"]')).toBeNull();
      await passSession();
      expect(section()!.querySelector('[data-exemption="e1"]')).not.toBeNull();
    });

    it('asks for the passphrase to unlock when the core does not hold the key', async () => {
      guard = null;
      locked = true;
      await renderSettings();
      expect(section()!.querySelector('[data-switch="verify"]')).toBeNull();
      const unlock = host.querySelector<HTMLFormElement>('[data-form="unlock"]')!;
      await act(async () => type(unlock.querySelector<HTMLInputElement>('input[type="password"]')!, PASS));
      await act(async () => unlock.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
      await flush();
      expect(calls.find((c) => c.url === '/api/p/vault/session')?.body).toEqual({ passphrase: PASS });
      expect(section()!.querySelector('[data-switch="verify"]')).not.toBeNull();
      expect(host.querySelector('[data-field="guard-passphrase"]')).toBeNull();
    });
  });

  describe('a variable where every Allow is verified', () => {
    const VAR: VaultVariable = { name: 'API', description: '', machines: [], injectOnly: true, created: '', updated: '' };
    const ruled = (over: Partial<VaultGuardFull> = {}) => guardOf({ verifyEachAllow: true, ...over });
    const reveals = () => calls.filter((c) => c.url === '/api/p/vault/vars/API/reveal');
    const puts = () => calls.filter((c) => c.method === 'PUT');
    const proofs = () => calls.filter((c) => c.url === '/api/p/vault/proof');
    const confirm = async () => {
      const dlg = useDialog.getState().current;
      await act(async () => {
        if (dlg?.kind === 'confirm') dlg.resolve(true);
      });
      await flush();
    };
    const reveal = async () => {
      await click('[data-name="API"] [data-action="reveal"]');
      await confirm();
    };
    const editor = () => document.body.querySelector<HTMLFormElement>('.vault-editor');
    const open = async () => {
      variables = [VAR];
      await renderPanel();
      await unlock();
    };
    const widen = async () => {
      await click('[data-name="API"] [data-action="edit"]');
      await act(async () => editor()!.querySelector<HTMLElement>('[role="switch"]')!.click());
    };
    const submit = async () => {
      await act(async () => editor()!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
      await flush();
    };
    const fresh = () => document.body.querySelector<HTMLInputElement>('[data-field="fresh-passphrase"]');

    it('shows a value by a proof made for its name, before the first request', async () => {
      creds = [CRED];
      guard = ruled({ authenticators: [auth()] });
      await open();
      await reveal();
      expect(proofs()[0].body).toEqual({ for: 'reveal', request: 'API' });
      expect(reveals()).toHaveLength(1);
      expect(reveals()[0].body.proof).toMatchObject({ nonce: NONCE, credential: CRED });
      expect(host.querySelector('.vault-value')?.textContent).toContain('secret-API');
    });

    it('shows a value by the passphrase when no proof can be made, and keeps asking after a wrong one', async () => {
      guard = ruled();
      await open();
      await reveal();
      expect(reveals()).toHaveLength(0);
      const field = () => host.querySelector<HTMLInputElement>('[data-fresh="reveal"] input')!;
      expect(field()).not.toBeNull();
      await act(async () => type(field(), 'nope'));
      await act(async () => host.querySelector<HTMLButtonElement>('[data-fresh="reveal"] button[type="submit"]')!.click());
      await flush();
      expect(reveals()[0].body).toEqual({ passphrase: 'nope' });
      expect(host.querySelector('.callout.error')?.textContent).toBe(t('vault.error.wrong_passphrase'));
      expect(host.querySelector('.vault-value')).toBeNull();
      await act(async () => type(field(), PASS));
      await act(async () => host.querySelector<HTMLButtonElement>('[data-fresh="reveal"] button[type="submit"]')!.click());
      await flush();
      expect(reveals()[1].body).toEqual({ passphrase: PASS });
      expect(host.querySelector('.vault-value')?.textContent).toContain('secret-API');
      expect(host.querySelector('[data-fresh="reveal"]')).toBeNull();
    });

    it('sends nothing extra while the page does not know of the rule, then answers vault_proof with a proof', async () => {
      creds = [CRED];
      guard = guardOf({ authenticators: [auth()] });
      serverRule = true;
      await open();
      await reveal();
      expect(reveals()).toHaveLength(2);
      expect(reveals()[0].body).toBeUndefined();
      expect(reveals()[1].body.proof).toBeDefined();
      expect(host.querySelector('.vault-value')).not.toBeNull();
    });

    it('leaves the row as it was when the proof is cancelled or refused', async () => {
      creds = [CRED];
      guard = ruled({ authenticators: [auth()] });
      await open();
      get.mockRejectedValueOnce(new DOMException('no', 'NotAllowedError'));
      await reveal();
      expect(reveals()).toHaveLength(0);
      expect(host.querySelector('.callout.error')?.textContent).toBe(t('vault.proof.cancelled'));
      expect(host.querySelector('.vault-value')).toBeNull();
      refuseProof = true;
      await reveal();
      expect(host.querySelector('.callout.error')?.textContent).toBe(t('vault.error.vault_proof'));
      expect(host.querySelector('.vault-value')).toBeNull();
    });

    it('saves a widening change by a proof made for the variable’s current name', async () => {
      creds = [CRED];
      guard = ruled({ authenticators: [auth()] });
      await open();
      await widen();
      await submit();
      expect(proofs()[0].body).toEqual({ for: 'change', request: 'API' });
      expect(puts()).toHaveLength(1);
      expect(puts()[0].body).toMatchObject({ injectOnly: false, proof: { nonce: NONCE, credential: CRED } });
      expect(editor()).toBeNull();
    });

    it('saves a widening change by the passphrase, asked in the editor', async () => {
      guard = ruled();
      await open();
      await widen();
      await submit();
      expect(puts()).toHaveLength(0);
      expect(editor()).not.toBeNull();
      expect(fresh()).not.toBeNull();
      expect(editor()!.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
      await act(async () => type(fresh()!, PASS));
      await submit();
      expect(puts()[0].body).toMatchObject({ injectOnly: false, passphrase: PASS });
      expect(editor()).toBeNull();
    });

    it('keeps the editor when the proof is cancelled or refused', async () => {
      creds = [CRED];
      guard = ruled({ authenticators: [auth()] });
      await open();
      await widen();
      get.mockRejectedValueOnce(new DOMException('no', 'NotAllowedError'));
      await submit();
      expect(puts()).toHaveLength(0);
      expect(editor()!.querySelector('.callout.error')?.textContent).toBe(t('vault.proof.cancelled'));
      refuseProof = true;
      await submit();
      expect(editor()!.querySelector('.callout.error')?.textContent).toBe(t('vault.error.vault_proof'));
    });

    it('asks nothing for a change that lets no more read the value', async () => {
      guard = ruled({ authenticators: [auth()] });
      await open();
      await click('[data-name="API"] [data-action="edit"]');
      await act(async () => {
        const area = editor()!.querySelector<HTMLTextAreaElement>('textarea')!;
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, 'note');
        area.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await submit();
      expect(proofs()).toHaveLength(0);
      expect(puts()).toHaveLength(1);
      expect(puts()[0].body.proof).toBeUndefined();
      expect(puts()[0].body.passphrase).toBeUndefined();
    });
  });
});
