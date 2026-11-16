// The settings dialog's Plugins page: every plugin of the app with what it
// does and its switch (its enable setting); parts of the app that are
// always on say so. A plugin's own settings are pages of their own. A
// switch whose setting machines can have of their own (program windows)
// sets the value of every machine without one, and says so. A plugin whose
// content runs on the UI's origin (VS Code) shows this kind of client's
// switch: in a browser, turning it on asks to accept the risk first.
import { useState } from 'react';
import { useSettings } from '../../settings';
import { enableSetting, pluginSwitch, setPluginSwitch, usePluginList } from '../../plugins/registry';
import { t } from '../../i18n';

export function PluginsPage({ readOnly }: { readOnly: boolean }) {
  const list = usePluginList((s) => s.list);
  const values = useSettings((s) => s.values);
  const defs = useSettings((s) => s.defs);
  const client = useSettings((s) => s.client);
  const [error, setError] = useState<string>();
  return (
    <div className="settings-section plugins-page">
      <p className="muted small">{t('plugins.page.about')}</p>
      {error && <p className="error small">{error}</p>}
      {list.map((p) => {
        const Icon = p.icon;
        const key = enableSetting(p, client);
        const on = pluginSwitch(p, values, client);
        const perMachine = !!key && defs.some((d) => d.key === key && d.scope !== 'app');
        return (
          <div key={p.id} className="setting plugin-row" data-plugin={p.id}>
            <Icon className="plugin-icon" />
            <div className="plugin-text">
              <div className="setting-title">{t(p.title)}</div>
              {p.description && <div className="muted small">{t(p.description)}</div>}
              {perMachine && <div className="muted small plugin-per-machine">{t('plugins.page.perMachine')}</div>}
              {p.browserRisk && (
                <div className="muted small plugin-client">
                  {t(client === 'browser' ? 'plugins.page.browserSwitch' : 'plugins.page.desktopSwitch')}
                </div>
              )}
            </div>
            {key ? (
              <label className="setting-check">
                <input
                  type="checkbox"
                  checked={on}
                  disabled={readOnly}
                  aria-label={t(p.title)}
                  onChange={async (e) => {
                    setError(undefined);
                    const err = await setPluginSwitch(p.id, e.target.checked);
                    if (err) setError(err);
                  }}
                />
              </label>
            ) : (
              <span className="muted small">{t('plugins.page.always')}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
