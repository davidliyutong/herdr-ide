// The variable vault feature: its routes below /api/p/vault for the pages,
// and the streams the agents open for their MCP servers' requests (op
// vault). The logic is the Vault's (vault.ts); the store's (store.ts).
import { randomBytes } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { defineFeature, type FeatureContext, type FeatureDef } from '#kernel/feature.ts';
import { Fail } from '#kernel/fail.ts';
import { readBody } from '#kernel/http/app.ts';
import type { Ctx, Env } from '#kernel/http/env.ts';
import { SLUG } from '#shared/lib/brand.ts';
import { formatRFC3339 } from '#shared/lib/gotime.ts';
import { Op } from '#shared/proto/agentproto/index.ts';
import { Result } from './accesslog.ts';
import { b64url, isCode, unb64, unb64url } from './crypto.ts';
import { proofMessage } from './desktop.ts';
import { MAX_EXPORT_FILE, MIN_EXPORT_PASSPHRASE, openExport, sealExport, weakExport, type ExportMachine } from './exportfile.ts';
import { PROOF_TTL, type Purpose } from './gate.ts';
import { settings } from './settings.ts';
import {
  ALL_MACHINES,
  checkApp,
  checkImport,
  KIND_DESKTOP,
  KIND_WEBAUTHN,
  MAX_ENTRIES,
  MAX_EXEMPTIONS,
  MAX_VALUE,
  MODE_PASSPHRASE,
  type Authenticator,
  type ExportVariable,
  type Import,
  type Info,
  type Store,
  type Update,
} from './store.ts';
import { isDesktop, UNLOCK_PRF } from './unlock.ts';
import {
  Answer,
  assertionOf,
  clip,
  For,
  ProofError,
  proofError,
  Vault,
  type Fresh,
  type ProofBody,
  type UnlockBody,
  type UnlockResult,
  type VaultOptions,
  type WorkspaceEnvResult,
} from './vault.ts';
import { verifyAssertion, verifyRegistration } from './webauthn.ts';

const str = z.string().nullish();
const proof = z.object({
  nonce: z.string().default(''),
  mac: str,
  credential: str,
  clientDataJSON: str,
  authenticatorData: str,
  signature: str,
});
const fresh = { proof: proof.nullish(), passphrase: str };
const opt = <T>(v: T | null | undefined): T | undefined => v ?? undefined;

/** A request's JSON body of at most limit bytes, against schema; optional
 * takes an empty body for {}. */
async function body<S extends z.ZodType>(c: Ctx, schema: S, limit: number, optional = false): Promise<z.output<S>> {
  const bytes = await readBody(c.req.raw, limit);
  let raw: unknown = {};
  if (bytes.length || !optional) {
    try {
      raw = JSON.parse(Buffer.from(bytes).toString('utf8'));
    } catch (e) {
      throw new Fail('bad_request', 400, `invalid JSON: ${(e as Error).message}`);
    }
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw new Fail('bad_request', 400, r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data;
}

const bad = (message: string) => new Fail('bad_request', 400, message);
const notFound = (message: string) => new Fail('not_found', 404, message);

export interface VaultFeature extends FeatureDef {
  /** Resolves environment variables of presets linked to (machine, workspace)
   * for injection into a new terminal or chat panel. Never exposes values
   * while disabled, locked, tampered, or when the access log fails. */
  workspaceEnv(machine: string, workspace: string, source: 'terminal' | 'chat'): Promise<WorkspaceEnvResult>;
}

export function vaultFeature(opts: VaultOptions = {}): VaultFeature {
  let instance: Vault | undefined;
  const def = defineFeature({
    id: 'vault',
    settings,
    setup(ctx: FeatureContext) {
      const v: Vault = new Vault(ctx, opts);
      instance = v;
      const { api } = ctx;
      const open = () => v.open();

      // The gate: a session; for what guards the vault, one the passphrase
      // opened; for the records, an open one that reading does not use.
      const gated: MiddlewareHandler<Env> = async (c, next) => {
        if (!v.sessionKind(c, true).open) v.refuseSession(c);
        await next();
      };
      const gatedPassphrase: MiddlewareHandler<Env> = async (c, next) => {
        const { open, byProof } = v.sessionKind(c, true);
        if (!open || byProof) v.refusePassphraseSession(c, open);
        await next();
      };
      const gatedRead: MiddlewareHandler<Env> = async (c, next) => {
        if (!v.sessionKind(c, false).open) v.refuseSession(c);
        await next();
      };

      api.get('/', async (c) => {
        const s = open();
        const { open: session, byProof } = v.sessionKind(c, false);
        const autoLock = v.autoLockState(s);
        // When the vault was last used is a session's to see.
        if (!session) delete autoLock.lockAt;
        return c.json({
          status: s.status(),
          variables: s.list(),
          groups: s.listGroups(),
          presets: s.listPresets(),
          workspaceLinks: s.listWorkspaceLinks(),
          session,
          sessionProof: session && byProof,
          idle: v.sessionLimits().idle / 1000,
          autoLock,
          guard: await v.guardState(c, s, session),
          unlock: v.unlockState(c, s),
        });
      });

      const setBody = z.object({
        to: str,
        description: str,
        group: str,
        machines: z.array(z.string()).nullish(),
        injectOnly: z.boolean().nullish(),
        value: str,
        ...fresh,
      });
      api.put('/vars/:name', ctx.mutating('set'), gated, async (c) => {
        const s = open();
        const b = await body(c, setBody, MAX_VALUE * 8);
        const u: Update = {
          to: opt(b.to),
          description: opt(b.description),
          group: opt(b.group),
          machines: opt(b.machines),
          injectOnly: opt(b.injectOnly),
          value: opt(b.value),
        };
        const from = c.req.param('name');
        let i: Info;
        try {
          // Widening and strict-mode verification run atomically inside Store's
          // write lock so concurrent link/group/variable edits cannot bypass it.
          i = await s.set(from, u, async (sv, existing) => {
            if (!v.sessionKind(c, false).open) v.refuseSession(c);
            const verified = existing
              ? await v.verifiedWith(c, sv, b, { for: For.Change, request: from })
              : await v.verifiedWith(c, sv, { passphrase: opt(b.passphrase) }, { for: '' });
            if (!verified) v.needFresh(c);
          });
        } catch (e) {
          if (isCode(e, 'vault_locked')) v.changed(); // pages that took it for unlocked learn otherwise
          throw e;
        }
        v.changed();
        // What changed, never the value.
        v.audit(c, 'vault.saved', {
          name: i.name,
          machines: i.machines,
          inject_only: i.injectOnly,
          value_changed: u.value !== undefined,
          ...(i.group ? { group: i.group } : {}),
          ...(i.name !== from ? { from } : {}),
        });
        return c.json(i);
      });

      api.delete('/vars/:name', ctx.mutating('delete'), gated, async (c) => {
        const name = c.req.param('name');
        await open().delete(name);
        v.audit(c, 'vault.deleted', { name });
        v.changed();
        return c.json({ ok: true });
      });

      // Groups: organize variables cleanly, with ungrouped fallback on delete.
      const groupBody = z.object({ name: str, description: str });
      api.post('/groups', ctx.mutating('group_add'), gated, async (c) => {
        const s = open();
        const b = await body(c, groupBody, 16 << 10);
        const g = await s.createGroup({ name: b.name ?? '', description: opt(b.description) });
        v.audit(c, 'vault.group_saved', { id: g.id, name: g.name });
        v.changed();
        return c.json(g);
      });

      api.put('/groups/:id', ctx.mutating('group_set'), gated, async (c) => {
        const s = open();
        const id = c.req.param('id');
        const b = await body(c, groupBody, 16 << 10);
        const g = await s.updateGroup(id, { name: opt(b.name), description: opt(b.description) });
        v.audit(c, 'vault.group_saved', { id: g.id, name: g.name });
        v.changed();
        return c.json(g);
      });

      api.delete('/groups/:id', ctx.mutating('group_delete'), gated, async (c) => {
        const id = c.req.param('id');
        await open().deleteGroup(id);
        v.audit(c, 'vault.group_deleted', { id });
        v.changed();
        return c.json({ ok: true });
      });

      api.post('/groups/assign', ctx.mutating('group_assign'), gated, async (c) => {
        const s = open();
        const b = await body(
          c,
          z.object({ names: z.array(z.string()).default([]), group: z.string().default(''), passphrase: str }),
          64 << 10,
        );
        await s.assignGroup(b.names, b.group, async (sv) => {
          if (!v.sessionKind(c, false).open) v.refuseSession(c);
          if (!(await v.verifiedWith(c, sv, { passphrase: opt(b.passphrase) }, { for: '' }))) v.needFresh(c);
        });
        v.audit(c, 'vault.group_assigned', { names: b.names, group: b.group });
        v.changed();
        return c.json({ ok: true });
      });

      // Presets: named collections of variables and/or groups.
      const presetBody = z.object({
        name: str,
        description: str,
        variables: z.array(z.string()).nullish(),
        groups: z.array(z.string()).nullish(),
        passphrase: str,
      });
      api.post('/presets', ctx.mutating('preset_add'), gated, async (c) => {
        const s = open();
        const b = await body(c, presetBody, 128 << 10);
        const p = await s.createPreset({
          name: b.name ?? '',
          description: opt(b.description),
          variables: b.variables ?? [],
          groups: b.groups ?? [],
        });
        v.audit(c, 'vault.preset_saved', { id: p.id, name: p.name, variables: p.variables, groups: p.groups });
        v.changed();
        return c.json(p);
      });

      api.put('/presets/:id', ctx.mutating('preset_set'), gated, async (c) => {
        const s = open();
        const id = c.req.param('id');
        const b = await body(c, presetBody, 128 << 10);
        const p = await s.updatePreset(
          id,
          {
            name: opt(b.name),
            description: opt(b.description),
            variables: opt(b.variables),
            groups: opt(b.groups),
          },
          async (sv) => {
            if (!v.sessionKind(c, false).open) v.refuseSession(c);
            if (!(await v.verifiedWith(c, sv, { passphrase: opt(b.passphrase) }, { for: '' }))) v.needFresh(c);
          },
        );
        v.audit(c, 'vault.preset_saved', { id: p.id, name: p.name, variables: p.variables, groups: p.groups });
        v.changed();
        return c.json(p);
      });

      api.delete('/presets/:id', ctx.mutating('preset_delete'), gated, async (c) => {
        const id = c.req.param('id');
        await open().deletePreset(id);
        v.audit(c, 'vault.preset_deleted', { id });
        v.changed();
        return c.json({ ok: true });
      });

      // Linking presets to a workspace on a machine: injected into new
      // terminals and chats of that workspace while the vault is unlocked.
      api.put('/workspaces/:machine/:workspace', ctx.mutating('workspace_link'), gated, async (c) => {
        const s = open();
        const machine = c.req.param('machine');
        const workspace = c.req.param('workspace');
        const b = await body(c, z.object({ presets: z.array(z.string()).default([]), passphrase: str }), 16 << 10);
        if (b.presets.length > 0 && (machine === ALL_MACHINES || !ctx.machines.get(machine)))
          throw new Fail('unknown_machine', 400, `no machine ${clip(machine, 64)}`);
        const link = await s.setWorkspacePresets(machine, workspace, b.presets, async (sv) => {
          if (!v.sessionKind(c, false).open) v.refuseSession(c);
          if (!(await v.verifiedWith(c, sv, { passphrase: opt(b.passphrase) }, { for: '' }))) v.needFresh(c);
        });
        v.audit(c, 'vault.workspace_linked', { machine, workspace, presets: b.presets });
        v.changed();
        return c.json({ link });
      });

      // The only way a value reaches a browser: audited, and recorded before
      // it leaves.
      api.post('/vars/:name/reveal', ctx.mutating('reveal'), gated, async (c) => {
        const s = open();
        const name = c.req.param('name');
        const f: Fresh = await body(c, z.object(fresh), 64 << 10, true);
        const value = await s.value(name, async (sv) => {
          if (!v.sessionKind(c, false).open) v.refuseSession(c);
          if (!(await v.verifiedWith(c, sv, f, { for: For.Reveal, request: name }))) v.needFresh(c);
        });
        if (!(await v.record(c, 'vault.revealed', v.pageAccess(c, 'reveal', [name], Result.Revealed)))) v.failLog();
        return c.json({ value });
      });

      // A session: with the passphrase (which unlocks), an authenticator's
      // unlock of a locked vault, or a proof of an unlocked one.
      const unlockSchema = z.object({
        nonce: z.string().default(''),
        id: str,
        relay: str,
        prf: z.object({ credential: str, output: str }).nullish(),
        assertion: proof.nullish(),
      });
      api.post('/session', ctx.mutating('session'), async (c) => {
        const s = open();
        const b = await body(c, z.object({ passphrase: str, proof: proof.nullish(), unlock: unlockSchema.nullish() }), 64 << 10);
        if (s.status().mode !== MODE_PASSPHRASE) throw new Fail('no_passphrase', 409, 'the vault has no passphrase yet');
        if (b.unlock) return sessionByUnlock(c, s, b.unlock);
        if (b.proof) return sessionByProof(c, s, b.proof);
        v.slowDown(c);
        let err: unknown = null;
        const tok = await v.keyMu.run(async () => {
          const epoch = v.gate.epoch;
          await opts.keyStep?.();
          const wasLocked = s.status().locked;
          // The window seals this unlock's auto-lock: the setting's for a
          // locked vault, else the current unlock's.
          try {
            await s.unlock(b.passphrase ?? '', v.window(wasLocked ? v.autoLockSetting() : v.autoLockAfter()));
          } catch (e) {
            err = e;
          }
          v.tried(err);
          if (err) return '';
          if (wasLocked) v.unlocked(0);
          const t = v.newSession(epoch, false);
          // The sessions ended while the check ran: a lock came after it.
          if (!t) err = new Fail('vault_locked', 409, 'the vault is locked');
          return t;
        });
        v.audit(c, 'vault.unlocked', { ok: !err });
        if (err) throw err;
        v.touch();
        v.changed();
        return c.json({ session: tok, idle: v.sessionLimits().idle / 1000, status: s.status() });
      });

      async function sessionByProof(c: Ctx, s: Store, pb: ProofBody) {
        const want: Purpose = { for: For.Session };
        let kind = '';
        let err: unknown = null;
        const tok = await v.keyMu.run(async () => {
          const epoch = v.gate.epoch;
          try {
            if (s.status().locked) throw new Fail('vault_locked', 409, 'the vault is locked');
            kind = await v.checkProof(c, s, pb, want);
          } catch (e) {
            err = e;
            return '';
          }
          const t = v.newSession(epoch, true);
          if (!t) err = new Fail('vault_locked', 409, 'the vault is locked');
          return t;
        });
        if (err) v.refuseProof(c, err, want);
        v.audit(c, 'vault.proved', { ok: true, for: want.for, kind });
        v.touch();
        v.changed();
        return c.json({ session: tok, proof: true, idle: v.sessionLimits().idle / 1000, status: s.status() });
      }

      // An unlock by an authenticator, slowed down with the passphrase's
      // checks: a key that does not open or verify counts as a wrong
      // passphrase; what guesses nothing does not count.
      async function sessionByUnlock(c: Ctx, s: Store, ub: UnlockBody) {
        v.slowDown(c);
        const r = await v.keyMu.run(async () => {
          const epoch = v.gate.epoch;
          await opts.keyStep?.();
          const wasLocked = s.status().locked;
          const res = await v.unlockWith(c, s, ub).catch((err: unknown): UnlockResult => ({
            id: '',
            kind: '',
            reason: '',
            removed: '',
            window: { days: 0, autoLockMs: 0 },
            err,
          }));
          if (isCode(res.err, 'unlock_stale') && (res.err as { why?: string }).why === 'orphan' && !res.removed) res.removed = 'orphan';
          v.tried(res.err, 'vault_proof');
          let tok = '';
          if (!res.err) {
            if (wasLocked) v.unlocked(res.window.autoLockMs);
            tok = v.newSession(epoch, true);
            if (!tok) res.err = new Fail('vault_locked', 409, 'the vault is locked');
          }
          return { res, tok };
        });
        const { res, tok } = r;
        if (res.removed) v.auditRemoved(c, res.id, res.kind, res.removed);
        // The wrap opened: the authenticator's secret is right but its
        // assertion is not, so the secret left the authenticator.
        if (res.reason) v.audit(c, 'denied.vault_proof', { route: `${c.req.method} ${c.req.path}`, kind: res.kind, reason: res.reason });
        v.audit(c, 'vault.unlocked', { ok: !res.err, ...(res.kind ? { kind: res.kind } : {}) });
        if (res.err) {
          if (isCode(res.err, 'unlock_stale')) v.changed(); // an entry went
          if (res.err instanceof ProofError) throw new Fail('vault_proof', 401, "the unlock does not hold; the vault's passphrase works");
          throw res.err;
        }
        v.touch();
        v.changed();
        return c.json({ session: tok, proof: true, idle: v.sessionLimits().idle / 1000, status: s.status() });
      }

      api.delete('/session', ctx.mutating('session_end'), (c) => {
        const tok = c.req.header('X-Vault-Session');
        if (tok) v.gate.end(tok);
        return c.json({ ok: true });
      });

      // A new vault's passphrase ({passphrase}), or a change ({old,
      // passphrase}); either opens a session. The first needs no session:
      // the vault has no values yet, and when it was set shows in the panel.
      api.post('/passphrase', ctx.mutating('passphrase'), async (c) => {
        const s = open();
        const b = await body(c, z.object({ old: z.string().nullish(), passphrase: z.string().default('') }), 64 << 10);
        const change = typeof b.old === 'string';
        if (change) v.slowDown(c);
        const before = s.unlockEntries();
        let err: unknown = null;
        const tok = await v.keyMu.run(async () => {
          const win = v.window(v.autoLockSetting());
          try {
            if (change) await s.changePassphrase(b.old!, b.passphrase, win);
            else await s.setPassphrase(b.passphrase, win);
          } catch (e) {
            err = e;
          }
          if (change) v.tried(err);
          if (err) return '';
          await opts.keyStep?.();
          const t = v.newSession(v.gate.endAll(), false);
          // A new key, set with the passphrase, unlocks as an unlock does.
          v.unlocked(0);
          return t;
        });
        v.audit(c, 'vault.passphrase_set', { ok: !err, change });
        if (err) throw err;
        // A new key ends every entry that wraps the old one.
        v.auditRemovedSince(c, s, before, 'stale');
        v.touch();
        v.changed();
        return c.json({ session: tok, idle: v.sessionLimits().idle / 1000, status: s.status() });
      });

      // Locks the vault (its key is forgotten, every session and nonce
      // ends); with {forget: true} also ends the passphrase's window, also
      // while locked.
      api.post('/lock', ctx.mutating('lock'), async (c) => {
        const s = open();
        const b = await body(c, z.object({ forget: z.boolean().nullish() }), 1 << 10, true);
        if (b.forget) c.var.audit.forget = true;
        let err: unknown = null;
        await v.keyMu.run(async () => {
          await v.lockStore(s);
          if (b.forget) await s.forgetPassphrase().catch((e) => (err = e));
        });
        v.changed();
        if (err) throw err;
        return c.json(s.status());
      });

      // A nonce for a proof: {for: session}, {for: answer, request, answer},
      // {for: reveal|change, request}, {for: register} (in a session the
      // passphrase opened). While locked only a session's, for an unlock.
      api.post('/proof', ctx.mutating('proof'), async (c) => {
        const s = open();
        const b = await body(c, z.object({ for: str, request: str, answer: str }), 4 << 10);
        let pu: Purpose;
        switch (b.for) {
          case For.Session:
            pu = { for: For.Session };
            break;
          case For.Answer:
            if (b.answer !== Answer.Once && b.answer !== Answer.Always) throw bad('answer is once or always');
            if (!v.pendingRequest(b.request ?? '')) throw notFound('no such request (answered or expired)');
            pu = { for: For.Answer, request: b.request!, answer: b.answer };
            break;
          case For.Register: {
            const { open: o, byProof } = v.sessionKind(c, true);
            if (!o || byProof) v.refusePassphraseSession(c, o);
            pu = { for: For.Register };
            break;
          }
          case For.Reveal:
          case For.Change:
            if (!s.get(b.request ?? '')) throw notFound('no such variable');
            pu = { for: b.for, request: b.request! };
            break;
          default:
            throw bad('for is session, answer, register, reveal or change');
        }
        const { origin, rpId } = v.originOf(c);
        // The vault's state and the nonce come together.
        const out = await v.keyMu.run(async () => {
          const st = s.status();
          const credentials: string[] = [];
          if (pu.for === For.Session && st.mode === MODE_PASSPHRASE && st.locked) {
            const prf: Record<string, string> = {};
            let desktop = false;
            for (const e of s.unlockEntries()) {
              if (e.kind === UNLOCK_PRF && origin && e.prf?.origin === origin && e.prf.rpId === rpId) {
                const id = b64url(unb64(e.prf.credential));
                credentials.push(id);
                prf[id] = b64url(unb64(e.prf.salt));
              } else if (isDesktop(e)) desktop = v.desktopCan(c);
            }
            const [nonce] = v.gate.issue(pu, true);
            return { nonce, rpId, credentials, desktop, ttl: PROOF_TTL / 1000, prf };
          }
          const g = await s.guard();
          let desktop = false;
          for (const a of g.authenticators ?? []) {
            if (a.kind === KIND_WEBAUTHN && origin && a.origin === origin) credentials.push(b64url(unb64(a.credential)));
            else if (a.kind === KIND_DESKTOP) desktop = v.desktopCan(c);
          }
          const [nonce, n] = v.gate.issue(pu, false);
          return {
            nonce,
            rpId,
            credentials,
            desktop,
            ttl: PROOF_TTL / 1000,
            ...(pu.for === For.Register ? { prfSalt: b64url(n.prfSalt!) } : {}),
          };
        });
        return c.json(out);
      });

      // What a nonce is for, for the desktop app's shell only: it shows that
      // in the system's prompt, whatever the page said.
      api.get('/proof/:nonce', async (c) => {
        const n = v.gate.peek(c.req.param('nonce'));
        if (!n || !v.desktopCan(c)) throw notFound('no such nonce');
        const pu = n.purpose;
        const out: Record<string, unknown> = { for: pu.for, answer: pu.answer ?? '' };
        if (pu.for === For.Reveal || pu.for === For.Change) out.name = pu.request;
        if (pu.for === For.Answer) {
          const req = v.pendingRequest(pu.request ?? '');
          if (!req) throw notFound('no such request (answered or expired)');
          // The label is the user's name for the machine, which programs can
          // change; the target (an ssh machine's address) is beside it.
          const m = ctx.machines.get(req.m);
          out.request = { id: req.id, machine: m?.label ?? req.m, target: m?.target ?? '', tool: req.tool, names: req.names };
        }
        if (pu.for === For.Session && n.locked) out.unlock = v.desktopEntries(open());
        if (pu.for === For.Register) out.register = { challenge: b64url(n.register!) };
        return c.json(out);
      });

      // Adds an authenticator in a session the passphrase opened, with the
      // passphrase again and a register proof, and wraps the key for it.
      const addSchema = z.object({
        kind: z.string().default(''),
        label: z.string().default(''),
        passphrase: z.string().default(''),
        nonce: z.string().default(''),
        mac: z.string().default(''),
        relay: z.string().default(''),
        clientDataJSON: str,
        authenticatorData: str,
        publicKey: str,
        alg: z.number().int().nullish(),
        assertion: proof.nullish(),
        prf: z.string().default(''),
      });
      api.post('/authenticators', ctx.mutating('authenticator_add'), gatedPassphrase, async (c) => {
        const s = open();
        const b = await body(c, addSchema, 64 << 10);
        const label = b.label.trim();
        if ([...label].length > 64 || (b.kind !== KIND_WEBAUTHN && b.kind !== KIND_DESKTOP))
          throw bad('kind is webauthn or desktop, with a label of at most 64 characters');
        c.var.audit.kind = b.kind;
        let output: Buffer = Buffer.alloc(0);
        if (b.kind === KIND_WEBAUTHN) {
          if (!b.prf)
            throw new Fail('prf_required', 400, "the credential's PRF output is needed: a credential without PRF cannot unlock the vault");
          output = unb64url(b.prf);
          if (output.length !== 32) throw bad('prf is 32 bytes, base64url');
        }
        try {
          await v.passphraseChecked(c, s, b.passphrase);
          const want: Purpose = { for: For.Register };
          const n = v.gate.take(b.nonce, want, false);
          if (!n) v.refuseProof(c, proofError(), want);
          const a: Authenticator = { id: randomBytes(8).toString('hex'), kind: b.kind, label, created: formatRFC3339(v.now()) };
          if (b.kind === KIND_DESKTOP) {
            const mac = /^(?:[0-9a-fA-F]{2})*$/.test(b.mac) ? Buffer.from(b.mac, 'hex') : null;
            if (!mac || !v.desktopCan(c) || !v.desktop!.proof(proofMessage(b.nonce, want), mac)) v.refuseProof(c, proofError(), want);
            await v.addDesktop(c, s, a, b.nonce, b.relay, n, b.passphrase);
          } else {
            const { origin, rpId } = v.originOf(c);
            if (!origin)
              throw new Fail(
                'webauthn_origin',
                400,
                "a WebAuthn credential is added from the UI's own address by name: http://localhost on the hub's port, or the reverse proxy's",
              );
            const e = { challenge: n.challenge, origin, rpId };
            const spki = unb64url(b.publicKey);
            let count: number;
            let cred: Buffer;
            try {
              cred = verifyRegistration(unb64url(b.clientDataJSON), unb64url(b.authenticatorData), e);
              if (!b.assertion || !unb64url(b.assertion.credential).equals(cred)) throw new Error('assertion of another credential');
              count = await verifyAssertion(b.alg ?? 0, spki, assertionOf(b.assertion), e);
            } catch {
              return v.refuseProof(c, proofError(), want);
            }
            Object.assign(a, { origin, rpId, credential: cred.toString('base64'), alg: b.alg, publicKey: spki.toString('base64') });
            if (count) a.signCount = count;
            // The authenticator and its entry are one step for a lock.
            const before = s.unlockEntries();
            let err: unknown = null;
            await v.keyMu.run(async () => {
              try {
                // A credential once: added again, it replaces itself.
                await s.updateGuard((g) => {
                  g.authenticators = [
                    ...(g.authenticators ?? []).filter(
                      (o) => !(o.kind === a.kind && o.origin === a.origin && unb64(o.credential).equals(cred)),
                    ),
                    a,
                  ];
                });
              } catch (x) {
                err = x;
                return;
              }
              try {
                await opts.addStep?.();
                await s.addPRF(a.id, origin, rpId, cred, n.prfSalt!, output, b.passphrase);
              } catch (x) {
                // Without its unlock entry it is not added.
                err = x;
                await v.dropAuthenticator(s, a.id);
              }
            });
            // The entry of the credential it replaced went with it.
            v.auditRemovedSince(c, s, before, 'orphan');
            if (err) throw err;
            c.var.audit.authenticator = a.id;
          }
        } finally {
          output.fill(0);
        }
        v.changed();
        return c.json({ guard: await v.guardState(c, s, true) });
      });

      // Removes an authenticator; its unlock entries go in the same write.
      api.delete('/authenticators/:id', ctx.mutating('authenticator_delete'), gatedPassphrase, async (c) => {
        const s = open();
        const id = c.req.param('id');
        let found = false;
        const before = s.unlockEntries();
        await s.updateGuard((g) => {
          found = !!g.authenticators?.some((a) => a.id === id);
          g.authenticators = g.authenticators?.filter((a) => a.id !== id);
        });
        if (!found) throw notFound('no such authenticator');
        v.auditRemovedSince(c, s, before, 'orphan');
        v.changed();
        return c.json({ guard: await v.guardState(c, s, true) });
      });

      // Sets the rule that every Allow needs a proof made for it. Ending it
      // takes the passphrase with the request: the page's session, which a
      // program driving the page has too, would end the rule that stands
      // against such a program.
      api.post('/guard', ctx.mutating('guard'), gatedPassphrase, async (c) => {
        const s = open();
        const b = await body(c, z.object({ verifyEachAllow: z.boolean().nullish(), passphrase: str }), 64 << 10);
        if (typeof b.verifyEachAllow !== 'boolean') throw bad('verifyEachAllow is true or false');
        c.var.audit.verifyEachAllow = b.verifyEachAllow;
        await s.updateGuard(
          (g) => {
            g.verifyEachAllow = b.verifyEachAllow!;
          },
          async (sv, strict) => {
            const { open: sessOpen, byProof } = v.sessionKind(c, false);
            if (!sessOpen || byProof) v.refusePassphraseSession(c, sessOpen);
            if (!b.verifyEachAllow && strict && !(await v.verifiedWith(c, sv, { passphrase: opt(b.passphrase) }, { for: '' })))
              throw new Fail('wrong_passphrase', 403, "the vault's passphrase is needed to end the rule");
          },
        );
        v.changed();
        return c.json({ guard: await v.guardState(c, s, true) });
      });

      // Exempts an app on machines: a lasting grant across every variable,
      // so it takes the passphrase again with the request.
      api.post('/exempt', ctx.mutating('exempt_add'), gatedPassphrase, async (c) => {
        const s = open();
        const b = await body(
          c,
          z.object({ app: z.string().default(''), machines: z.array(z.string()).nullish(), passphrase: str }),
          16 << 10,
        );
        const machines = b.machines ?? [];
        if (!machines.length || machines.length > MAX_EXEMPTIONS) throw bad('1 to 64 machines');
        const bad_ = checkApp(b.app);
        if (bad_) throw bad_;
        for (const m of machines)
          if (!m || m === ALL_MACHINES || !ctx.machines.get(m)) throw new Fail('unknown_machine', 400, `no machine ${clip(m, 64)}`);
        Object.assign(c.var.audit, { app: b.app, machines });
        await v.passphraseAgain(c, s, opt(b.passphrase));
        const now = formatRFC3339(v.now());
        await s.updateGuard((g) => {
          for (const m of machines)
            if (!g.exempt?.some((e) => e.machine === m && e.app === b.app))
              g.exempt = [...(g.exempt ?? []), { id: randomBytes(8).toString('hex'), machine: m, app: b.app, created: now }];
        });
        v.changed();
        return c.json({ guard: await v.guardState(c, s, true) });
      });

      api.delete('/exempt/:id', ctx.mutating('exempt_delete'), gatedPassphrase, async (c) => {
        const s = open();
        const id = c.req.param('id');
        let found = false;
        await s.updateGuard((g) => {
          const e = g.exempt?.find((x) => x.id === id);
          if (e) {
            found = true;
            Object.assign(c.var.audit, { app: e.app, machine: e.machine });
          }
          g.exempt = g.exempt?.filter((x) => x.id !== id);
        });
        if (!found) throw notFound('no such exemption');
        v.changed();
        return c.json({ guard: await v.guardState(c, s, true) });
      });

      api.get('/requests', (c) => c.json({ requests: v.pending() }));

      // Answers a request. Letting a value out is behind the gate (a
      // session; where every Allow is verified, a proof made for this
      // answer or the passphrase); denying needs nothing.
      api.post('/requests/:id', ctx.mutating('answer'), async (c) => {
        const b = await body(c, z.object({ answer: z.string().default(''), ...fresh }), 64 << 10);
        const id = c.req.param('id');
        let req;
        if (b.answer === Answer.Once || b.answer === Answer.Always) {
          const s = open();
          req = await s.authorizeAllow(async (sv) => {
            if (!(await v.verifiedWith(c, sv, b, { for: For.Answer, request: id, answer: b.answer }))) {
              if (await sv.strict()) v.needFresh(c);
              if (!v.sessionKind(c, true).open) v.refuseSession(c);
            }
            return v.answerRequest(id, b.answer);
          });
        } else if (b.answer === Answer.Deny) {
          req = v.answerRequest(id, b.answer);
        } else {
          throw bad('answer is once, always or deny');
        }
        if (!req) throw notFound('no such request (answered or expired)');
        v.audit(c, 'vault.answered', { id: req.id, machine: req.m, tool: req.tool, names: req.names, answer: b.answer });
        return c.json({ ok: true });
      });

      api.get('/log', gatedRead, async (c) => c.json({ log: await v.accessLog().list() }));

      transferRoutes(ctx, v, gatedPassphrase);

      ctx.agentStream(Op.Vault, (m, conn, h) => void v.serveAgent(m.id, conn, h));
      ctx.onForget((id) => void v.forgetMachine(id));
      ctx.service('timers', async (signal) => {
        await new Promise((r) => (signal.aborted ? r(null) : signal.addEventListener('abort', r, { once: true })));
        await v.stop();
      });
    },
  });
  return Object.assign(def, {
    workspaceEnv: (machine: string, workspace: string, source: 'terminal' | 'chat') =>
      instance
        ? instance.workspaceEnv(machine, workspace, source)
        : Promise.resolve({ env: {}, names: [], presets: [], missing: [], locked: false }),
  });
}

// Export and import: variables leave in an encrypted file the hub builds,
// so values never reach a browser, and come back in one write. An export is
// a bulk release: the passphrase again, recorded before the file is sent.
// An import sends the file and its passphrase twice, for the preview and
// the changes: the hub keeps nothing of a file between the two.
function transferRoutes(ctx: FeatureContext, v: Vault, gatedPassphrase: MiddlewareHandler<Env>): void {
  const { api } = ctx;

  /** The machines the variables' lists name, with their labels, kinds and
   * targets here. */
  const exportMachines = (vars: ExportVariable[]): ExportMachine[] => {
    const seen = new Set<string>();
    const out: ExportMachine[] = [];
    for (const id of vars.flatMap((x) => x.machines)) {
      if (id === ALL_MACHINES || seen.has(id)) continue;
      seen.add(id);
      const mc = ctx.machines.get(id);
      const local = mc ? mc.local : id === 'local';
      out.push({
        id,
        ...(mc?.label ? { label: mc.label } : {}),
        ...(local ? { local } : {}),
        ...(mc ? { kind: mc.kind } : {}),
        ...(mc?.target ? { target: mc.target } : {}),
      });
    }
    return out;
  };

  /** A variable's machines in a file mapped to this hub's: "*" stays; an
   * ssh machine by its id only with the same kind and target here; the
   * local machine only when its label is the same too; labels alone map
   * nothing. The others leave the list (they ask every time). */
  const mapMachines = (file: ExportMachine[], ms: string[]) => {
    const mapped: string[] = [];
    const unknown: string[] = [];
    for (const id of ms) {
      if (id === ALL_MACHINES) {
        mapped.push(id);
        continue;
      }
      const mc = ctx.machines.get(id);
      const f = file.find((m) => m.id === id);
      const ok = !!mc && !!f && (mc.local ? !!f.label && f.label === mc.label : f.kind === mc.kind && !!f.target && f.target === mc.target);
      (ok ? mapped : unknown).push(id);
    }
    return { mapped, unknown };
  };

  api.post('/export', ctx.mutating('export'), gatedPassphrase, async (c) => {
    const s = v.open();
    const b = await body(
      c,
      z.object({
        passphrase: z.string().default(''),
        filePassphrase: z.string().default(''),
        names: z.array(z.string()).nullish(),
        all: z.boolean().nullish(),
      }),
      1 << 20,
    );
    if ([...b.filePassphrase].length < MIN_EXPORT_PASSPHRASE) throw weakExport();
    const names = [...new Set(b.all ? s.list().map((i) => i.name) : (b.names ?? []))];
    if (!names.length || names.length > MAX_ENTRIES) throw bad('names to export, or all');
    if (s.status().mode !== MODE_PASSPHRASE) throw new Fail('no_passphrase', 409, 'the vault has no passphrase yet');
    // A bulk release: the vault's passphrase again, checked as any other.
    await v.passphraseChecked(c, s, b.passphrase);
    const file = await v.fileWork(c, async () => {
      const vars = await s.exportVariables(names);
      try {
        return await sealExport(
          { exported: formatRFC3339(new Date()), machines: exportMachines(vars), variables: vars },
          b.filePassphrase,
          s.kdf,
        );
      } finally {
        for (const x of vars) x.value = '';
      }
    });
    c.var.audit.count = names.length;
    // The file leaves only once its record is written.
    if (!(await v.record(c, 'vault.exported', v.pageAccess(c, 'export', names, Result.Exported)))) v.failLog();
    const d = new Date();
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return c.body(new Uint8Array(file), 200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="${SLUG}-vault-${day}.json"`,
      'Content-Length': String(file.length),
    });
  });

  const importSchema = z.object({
    file: z.string().default(''),
    passphrase: z.string().default(''),
    choices: z.array(z.object({ i: z.number().int(), action: z.string().default(''), as: str })).nullish(),
  });
  /** An import's request and its file opened. */
  const readImport = async (c: Ctx) => {
    const b = await body(c, importSchema, 2 * MAX_EXPORT_FILE + (1 << 20));
    if (Buffer.byteLength(b.file) > MAX_EXPORT_FILE) throw new Fail('too_large', 413, 'the export file is too large');
    return { b, e: await v.fileWork(c, () => openExport(Buffer.from(b.file), b.passphrase)) };
  };
  const importOf = (x: ExportVariable, machines: string[], overwrite: boolean): Import => ({
    name: x.name,
    value: x.value,
    description: x.description ?? '',
    machines,
    injectOnly: !!x.injectOnly,
    created: x.created,
    overwrite,
  });

  // What a file holds, without values.
  api.post('/import/preview', ctx.mutating('import_preview'), gatedPassphrase, async (c) => {
    const s = v.open();
    const { e } = await readImport(c);
    const variables = e.variables.map((x) => {
      const { mapped, unknown } = mapMachines(e.machines, x.machines);
      const invalid = checkImport(importOf(x, mapped, false))?.code;
      return {
        name: x.name,
        description: x.description ?? '',
        injectOnly: !!x.injectOnly,
        machines: mapped,
        ...(unknown.length ? { unknown } : {}),
        exists: !!s.get(x.name),
        ...(invalid ? { invalid } : {}),
      };
    });
    for (const x of e.variables) x.value = '';
    const machines = e.machines.map((m) => ({
      id: m.id,
      label: m.label ?? '',
      local: !!m.local,
      known: !mapMachines(e.machines, [m.id]).unknown.length,
    }));
    return c.json({ exported: e.exported, variables, machines });
  });

  // Imports a file's variables as chosen, in one write.
  api.post('/import', ctx.mutating('import'), gatedPassphrase, async (c) => {
    const s = v.open();
    const { b, e } = await readImport(c);
    const list: Import[] = [];
    const names: string[] = [];
    const overwritten: string[] = [];
    const renamed: Record<string, string> = {};
    const done = new Set<number>();
    try {
      for (const ch of b.choices ?? []) {
        if (ch.i < 0 || ch.i >= e.variables.length || done.has(ch.i)) throw bad('a choice names no variable of the file, or one twice');
        done.add(ch.i);
        const x = e.variables[ch.i];
        const im = importOf(x, mapMachines(e.machines, x.machines).mapped, false);
        if (ch.action === 'skip') continue;
        if (ch.action === 'overwrite') {
          im.overwrite = true;
          overwritten.push(x.name);
        } else if (ch.action === 'rename') {
          im.name = ch.as ?? '';
          renamed[im.name] = x.name;
        } else if (ch.action !== 'import') throw bad('action is import, overwrite, rename or skip');
        list.push(im);
        names.push(im.name);
      }
      if (!list.length) throw bad('nothing to import');
      await s.importVariables(list).catch((x) => {
        if (isCode(x, 'vault_locked')) v.changed();
        throw x;
      });
    } finally {
      for (const x of [...list, ...e.variables]) x.value = '';
    }
    v.audit(c, 'vault.imported', {
      names,
      ...(overwritten.length ? { overwritten } : {}),
      ...(Object.keys(renamed).length ? { renamed } : {}),
    });
    v.changed();
    return c.json({ imported: names });
  });
}
