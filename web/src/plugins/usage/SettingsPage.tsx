// The AI usage plugin's page in Settings (PluginSettingsDef.layout): the
// settings that are no provider's, in their groups, then the providers, a
// row each with its mark, its name and whether it is on (the bar of a
// changed setting when one of its settings is). A row opens the
// provider's own settings (its group: its switch, then its options,
// backend/features/usage providerGroup), a page of its own below a Back
// button and the provider's name; the plugin and its switch are on the
// first page only. Choosing AI Usage in the dialog's list again shows the
// first page too. Opened at a provider's setting (openSettings({row})),
// the page shows that provider. The search lists the rows it finds as on
// any page.
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { useSettings, type SettingDef } from '../../settings';
import { useStore } from '../../state/store';
import { t } from '../../i18n';
import type { PluginSettingsLayoutProps } from '../api';
import { ProviderLogo } from './logos';
import { providerName } from './model';

const SWITCH = 'usage.providers.';

/** The providers among the settings shown, in their order, each with the
 * settings of its group. */
export function providerPages(defs: SettingDef[]): { id: string; switch: SettingDef; defs: SettingDef[] }[] {
  return defs
    .filter((d) => d.key.startsWith(SWITCH) && d.group)
    .map((d) => ({ id: d.key.slice(SWITCH.length), switch: d, defs: defs.filter((x) => x.group === d.group) }));
}

export function UsageSettings({ defs, rows, lead, visit }: PluginSettingsLayoutProps) {
  const values = useSettings((s) => s.values);
  const asked = useStore((s) => s.settings?.row);
  const providers = providerPages(defs);
  const providerOf = (key?: string) => providers.find((p) => p.defs.some((d) => d.key === key))?.id;
  const [open, setOpen] = useState(() => providerOf(asked));
  // Opened at a row of this page: where that row is.
  useEffect(() => {
    if (defs.some((d) => d.key === asked)) setOpen(providerOf(asked));
  }, [asked]);
  // Chosen in the dialog's list again: the first page.
  const seen = useRef(visit);
  useEffect(() => {
    if (seen.current !== visit) setOpen(undefined);
    seen.current = visit;
  }, [visit]);

  const page = providers.find((p) => p.id === open);
  if (page)
    return (
      <div className="usage-settings-provider" data-provider={page.id}>
        <button className="sm usage-settings-back" data-action="back" onClick={() => setOpen(undefined)}>
          <ArrowLeft aria-hidden /> {t('usage.settings.back')}
        </button>
        <h4 className="usage-settings-title">
          <ProviderLogo provider={page.id} />
          <span>{providerName(page.id)}</span>
        </h4>
        {/* The heading names the group. */}
        {rows(page.defs.map((d) => ({ ...d, group: undefined })))}
      </div>
    );

  const own = new Set(providers.flatMap((p) => p.defs));
  return (
    <>
      {lead}
      {rows(defs.filter((d) => !own.has(d)))}
      {providers.length > 0 && <h4 className="settings-group">{t('settings.group.usageProviders')}</h4>}
      <div className="usage-settings-providers">
        {providers.map((p) => {
          const on = (values[p.switch.key]?.value ?? p.switch.default) !== false;
          const modified = p.defs.some((d) => values[d.key]?.source === 'global');
          return (
            <button
              key={p.id}
              className={['setting usage-settings-row', !on && 'off', modified && 'modified'].filter(Boolean).join(' ')}
              data-provider={p.id}
              onClick={() => setOpen(p.id)}
            >
              <ProviderLogo provider={p.id} />
              <span className="setting-title ellipsis">{providerName(p.id)}</span>
              <span className="muted">{t(on ? 'settings.on' : 'settings.off')}</span>
              <ChevronRight aria-hidden />
            </button>
          );
        })}
      </div>
    </>
  );
}
