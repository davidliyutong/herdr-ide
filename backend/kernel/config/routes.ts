// Settings and keybindings over HTTP (docs/features/13-settings-and-appearance.md):
// the definitions and values for every UI, changed through the API or by
// editing the files, and pushed to every page after each change ("settings"
// and "keybindings" messages on /ws carry the new state, so pages need not
// ask again; a page reads both with GET when it starts).
import { z } from 'zod';
import { jsonBody, type Http } from '../http/app.ts';
import type { Pages } from '../pages.ts';
import { ConfigFail, detailed } from './fail.ts';
import { SECTIONS, type Keybindings } from './keybindings/index.ts';
import type { Settings } from './settings/index.ts';

export interface SettingsRoutesDeps {
  settings: Settings;
  keybindings: Keybindings;
  pages: Pages;
}

// {key, value, machine?}: the value typed as the definition says (true,
// 14, "dark", ["#000000", …]); machine sets that machine's own value.
const change = z
  .object({ key: z.string().default(''), value: z.unknown(), machine: z.string().default('') })
  .refine((b) => b.value !== undefined, { message: 'no value', path: ['value'] });

/** Serves /api/settings and /api/keybindings on http and pushes their
 * changes to the pages; returns what stops the pushes. */
export function settingsRoutes(http: Http, { settings, keybindings, pages }: SettingsRoutesDeps): () => void {
  const { app } = http;
  const readOnly = http.options.readOnly;

  /** A per-machine change names a machine the core has, and not the
   * core's own for settings of remote machines only. */
  const target = (key: string, machine: string) => {
    if (!machine) return;
    const m = http.options.machine(machine);
    if (!m) throw new ConfigFail('unknown', 404, `unknown machine ${machine}`, `machine ${machine}`);
    if (settings.lookup(key)?.scope === 'remote-machine' && m.local) throw detailed('scope', 400, `${key} applies to remote machines only`);
  };

  // The sections, definitions and values, so the UIs render their forms
  // without knowing the settings in advance, and which kind of client asks
  // (which switch of a feature with one per kind of client applies).
  app.get('/api/settings', (c) =>
    c.json({
      sections: settings.sections(),
      definitions: settings.definitions(),
      ...settings.state(),
      read_only: readOnly,
      file: settings.path,
      client: c.var.client,
    }),
  );

  app.put('/api/settings', http.mutating('settings.set'), jsonBody(change, { code: 'invalid', limit: 64 << 10 }), (c) => {
    const { key, value, machine } = c.req.valid('json');
    Object.assign(c.var.audit, { key, value, machine });
    target(key, machine);
    settings.set(key, machine, value);
    return c.json(settings.state());
  });

  // ?key=&machine=: the global value goes back to the default, a machine's
  // own to the global one.
  app.delete('/api/settings', http.mutating('settings.reset'), (c) => {
    const key = c.req.query('key') ?? '';
    const machine = c.req.query('machine') ?? '';
    Object.assign(c.var.audit, { key, machine });
    target(key, machine);
    settings.reset(key, machine);
    return c.json(settings.state());
  });

  // The commands, the default bindings, the user's rules and, per
  // platform, the bindings in effect and their conflicts.
  app.get('/api/keybindings', (c) =>
    c.json({
      sections: SECTIONS,
      commands: keybindings.commands(),
      defaults: keybindings.allDefaults(),
      ...keybindings.state(),
      read_only: readOnly,
      file: keybindings.path,
    }),
  );

  // Replaces the user's rules with the array in the body.
  app.put(
    '/api/keybindings',
    http.mutating('keybindings.set'),
    jsonBody(z.array(z.unknown()), { code: 'invalid', limit: 256 << 10 }),
    (c) => {
      const user = c.req.valid('json');
      Object.assign(c.var.audit, { rules: user.length });
      keybindings.setUser(user);
      return c.json(keybindings.state());
    },
  );

  const stops = [
    settings.onChange(() => pages.broadcast({ t: 'settings', ...settings.state() })),
    keybindings.onChange(() => pages.broadcast({ t: 'keybindings', ...keybindings.state() })),
  ];
  return () => {
    for (const stop of stops) stop();
  };
}
