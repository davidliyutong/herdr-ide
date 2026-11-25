// What the plugins' requests share (lib/pluginApi.ts): failures with the
// hub's code under each plugin's own class, the options of a JSON request
// and a failure's text by its code.
import { describe, expect, it } from 'vitest';
import { answer, failureOf, jsonBody, jsonInit, makeErrorText, PluginError } from '../lib/pluginApi';
import { t } from '../i18n';
import { ConflictError, errorText as filesText, FilesError } from '../plugins/files/api';
import { errorText as gitText, GitError } from '../plugins/git/api';
import { errorText as vaultText, VaultError } from '../plugins/vault/api';
import { BrowserError } from '../plugins/browser/api';

const json = (status: number, body: unknown, statusText = '') =>
  new Response(JSON.stringify(body), { status, statusText, headers: { 'Content-Type': 'application/json' } });

describe('plugin errors', () => {
  it('keep their own classes under the shared one', () => {
    const f = new FilesError('busy', 'x');
    const g = new GitError('git_failed', 'git_failed: boom');
    const v = new VaultError('vault_session');
    const b = new BrowserError('network', '');
    for (const e of [f, g, v, b]) expect(e).toBeInstanceOf(PluginError);
    expect(f).not.toBeInstanceOf(GitError);
    expect(g).not.toBeInstanceOf(FilesError);
    expect([f.name, g.name, b.name]).toEqual(['FilesError', 'GitError', 'BrowserError']);
    // A vault failure without a message says its code.
    expect([v.code, v.message, v.variable]).toEqual(['vault_session', 'vault_session', undefined]);
    expect(new VaultError('invalid', 'bad', 'A').variable).toBe('A');
    const c = new ConflictError({ path: '/a', exists: true, size: 1, mtime: 2 });
    expect(c).toBeInstanceOf(FilesError);
    expect(c.code).toBe('conflict');
  });
});

describe('answer', () => {
  const fail = failureOf((code, message) => new GitError(code, message));

  it('gives the JSON of an answer that is ok, {} when it has none', async () => {
    expect(await answer(json(200, { a: 1 }), fail)).toEqual({ a: 1 });
    expect(await answer(new Response('', { status: 200 }), fail)).toEqual({});
    // A list, or the null of an empty one, stays what it is.
    expect(await answer(json(200, [1]), fail)).toEqual([1]);
    expect(await answer(json(200, null), fail)).toBeNull();
    expect(await jsonBody(new Response('not json', { status: 200 }))).toEqual({});
  });

  it('throws the failure with the body’s code and message, or the status', async () => {
    await expect(answer(json(400, { error: 'busy', message: 'm' }), fail)).rejects.toMatchObject({ code: 'busy', message: 'm' });
    const e = await answer(new Response('oops', { status: 502, statusText: 'Bad Gateway' }), fail).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(GitError);
    expect(e).toMatchObject({ code: 'http_502', message: 'Bad Gateway' });
  });
});

describe('jsonInit', () => {
  it('sends a body as JSON with its type, and none without', () => {
    expect(jsonInit('POST', { a: 1 })).toEqual({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"a":1}' });
    expect(jsonInit('PUT', { a: 1 }, { 'X-Vault-Session': 's' }).headers).toEqual({
      'Content-Type': 'application/json',
      'X-Vault-Session': 's',
    });
    const none = jsonInit('GET', undefined, { 'X-Vault-Session': 's' });
    expect(none.headers).toEqual({ 'X-Vault-Session': 's' });
    expect(none.body).toBeUndefined();
  });
});

describe('error texts', () => {
  it('files: the code’s message, a partial write by its cause, else what the failure says', () => {
    expect(filesText(new FilesError('partial_write', 'no_space'))).toBe(t('files.error.partial_write.no_space'));
    expect(filesText(new FilesError('partial_write', 'io'))).toBe(t('files.error.partial_write'));
    expect(filesText(new FilesError('no_such_code', 'said'))).toBe('said');
    expect(filesText(new FilesError('no_such_code', ''))).toBe('no_such_code');
    expect(filesText(new Error('plain'))).toBe('plain');
    expect(filesText('text')).toBe('text');
    expect(new FilesError('no_such_code', 'said').userText()).toBe('said');
  });

  it('git: what git said after the message of git_failed and conflicts', () => {
    expect(gitText(new GitError('git_failed', 'git_failed: fatal: bad'))).toBe(`${t('git.error.git_failed')} fatal: bad`);
    expect(gitText(new GitError('git_failed', ''))).toBe(t('git.error.git_failed'));
    expect(gitText(new GitError('no_such_code', 'said'))).toBe('said');
    expect(gitText(new Error('plain'))).toBe('plain');
    // Another plugin's failure is not Git's: its message, not Git's text of the code.
    expect(gitText(new FilesError('git_failed', 'other'))).toBe('other');
  });

  it('vault: never the failure’s own words', () => {
    expect(vaultText(new VaultError('no_such_code', 'secret detail'))).toBe(t('vault.error.failed'));
    expect(vaultText(new Error('plain'))).toBe(t('vault.error.failed'));
    expect(vaultText(new VaultError('failed'))).toBe(t('vault.error.failed'));
  });

  it('makeErrorText asks special first, then the message, then the fallback', () => {
    const text = makeErrorText(GitError, 'git.error', { special: (e) => (e.code === 'x' ? 'own' : undefined), fallback: () => 'fb' });
    expect(text(new GitError('x', ''))).toBe('own');
    expect(text(new GitError('git_failed', 'git_failed: d'))).toBe(t('git.error.git_failed'));
    expect(text(new GitError('no_such_code', 'm'))).toBe('fb');
    expect(text(1)).toBe('fb');
  });
});
