// The settings dialog's Plugins page: every plugin of the app with what it
// does and its switch (its enable setting); parts of the app that are
// always on say so. A plugin with settings of its own has a button that
// opens their page, which the dialog lists under the plugins; that page
// starts with the plugin and its switch (PluginHeader) and says when the
// plugin is off. A switch whose setting machines can have of their own
// (program windows) sets the value of every machine without one, and says
// so. A plugin whose content runs on the UI's origin (VS Code) shows this
// kind of client's switch: in a browser, turning it on asks to accept the
// risk first.
import { useState } from 'react';
import { Settings as SettingsIcon } from 'lucide-react';
import { useSettings } from '../../settings';
import { enableSetting, pluginSection, pluginSwitch, setPluginSwitch, usePluginList } from '../../plugins/registry';
import type { PluginDef } from '../../plugins/api';
import { useStore } from '../../state/store';
import { t } from '../../i18n';

/** A plugin's switch (this kind of client's enable setting), or "Always on". */
function PluginSwitch({ p, readOnly, onError }: { p: PluginDef; readOnly: boolean; onError(e: string | undefined): void }) {
  const values = useSettings((s) => s.values);
  const client = useSettings((s) => s.client);
  if (!enableSetting(p, client)) return <span className="muted small">{t('plugins.page.always')}</span>;
  return (
    <label className="setting-check">
      <input
        type="checkbox"
        checked={pluginSwitch(p, values, client)}
        disabled={readOnly}
        aria-label={t(p.title)}
        onChange={async (e) => {
          onError(undefined);
          onError(await setPluginSwitch(p.id, e.target.checked));
        }}
      />
    </label>
  );
}

/** What a plugin's row says besides its description: a switch of the
 * User value (per machine), this kind of client's switch (VS Code). */
function SwitchNotes({ p }: { p: PluginDef }) {
  const defs = useSettings((s) => s.defs);
  const client = useSettings((s) => s.client);
  const key = enableSetting(p, client);
  const perMachine = !!key && defs.some((d) => d.key === key && d.scope !== 'app');
  return (
    <>
      {perMachine && <div className="muted small plugin-per-machine">{t('plugins.page.perMachine')}</div>}
      {p.browserRisk && (
        <div className="muted small plugin-client">
          {t(client === 'browser' ? 'plugins.page.browserSwitch' : 'plugins.page.desktopSwitch')}
        </div>
      )}
    </>
  );
}

/** The plugin, its description and switch: the top of its settings page;
 * says when it is off. */
export function PluginHeader({ p, readOnly, withSwitch = true }: { p: PluginDef; readOnly: boolean; withSwitch?: boolean }) {
  const values = useSettings((s) => s.values);
  const client = useSettings((s) => s.client);
  const [error, setError] = useState<string>();
  const Icon = p.icon;
  const on = pluginSwitch(p, values, client);
  return (
    <div className={`plugin-header ${on ? '' : 'off'}`} data-plugin={p.id}>
      <div className="setting plugin-row">
        <Icon className="plugin-icon" />
        <div className="plugin-text">
          <div className="setting-title">{t(p.title)}</div>
          {p.description && <div className="muted small">{t(p.description)}</div>}
          {withSwitch && <SwitchNotes p={p} />}
        </div>
        {withSwitch && <PluginSwitch p={p} readOnly={readOnly} onError={setError} />}
      </div>
      {!on && <p className="callout warning small plugin-off">{t('plugins.page.off', { plugin: t(p.title) })}</p>}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

export function PluginsPage({ readOnly, onOpen }: { readOnly: boolean; onOpen?(page: string): void }) {
  const list = usePluginList((s) => s.list);
  const defs = useSettings((s) => s.defs);
  const sections = useSettings((s) => s.sections);
  const [error, setError] = useState<string>();
  const open = onOpen ?? ((page: string) => useStore.getState().openSettings({ page }));
  return (
    <div className="settings-section plugins-page">
      <p className="muted small">{t('plugins.page.about')}</p>
      {error && <p className="error small">{error}</p>}
      {list.map((p) => {
        const Icon = p.icon;
        const section = pluginSection(p, sections);
        const page = section && (defs.some((d) => d.section === section) || p.settings?.extra) ? section : undefined;
        return (
          <div key={p.id} className="setting plugin-row" data-plugin={p.id}>
            <Icon className="plugin-icon" />
            <div className="plugin-text">
              <div className="setting-title">{t(p.title)}</div>
              {p.description && <div className="muted small">{t(p.description)}</div>}
              <SwitchNotes p={p} />
            </div>
            {page && (
              <button
                className="icon plugin-settings"
                title={t('plugins.page.settings', { plugin: t(p.title) })}
                aria-label={t('plugins.page.settings', { plugin: t(p.title) })}
                onClick={() => open(page)}
              >
                <SettingsIcon />
              </button>
            )}
            <PluginSwitch p={p} readOnly={readOnly} onError={setError} />
          </div>
        );
      })}
    </div>
  );
}
