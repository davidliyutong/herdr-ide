// The settings dialog's Plugins page: every plugin of the app with what it
// does and its switch (its enable setting); parts of the app that are
// always on say so. A plugin's own settings are pages of their own.
import { useState } from 'react';
import { setSetting, useSettings } from '../../settings';
import { enableSetting, pluginOn, usePluginList } from '../../plugins/registry';
import { t } from '../../i18n';

export function PluginsPage({ readOnly }: { readOnly: boolean }) {
  const list = usePluginList((s) => s.list);
  const values = useSettings((s) => s.values);
  const [error, setError] = useState<string>();
  return (
    <div className="settings-section plugins-page">
      <p className="muted small">{t('plugins.page.about')}</p>
      {error && <p className="error small">{error}</p>}
      {list.map((p) => {
        const Icon = p.icon;
        const key = enableSetting(p);
        const on = pluginOn(p, values);
        return (
          <div key={p.id} className="setting plugin-row" data-plugin={p.id}>
            <Icon className="plugin-icon" />
            <div className="plugin-text">
              <div className="setting-title">{t(p.title)}</div>
              {p.description && <div className="muted small">{t(p.description)}</div>}
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
                    const err = await setSetting(key, e.target.checked);
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
