// The switches of the features that can be turned off, in the section
// "plugins" (kernel/feature.ts enableSetting names the one that applies to
// a client).
import { bool, defineModule, type Module, type Setting } from './settings/index.ts';

/** What the switches depend on of a feature (FeatureDef's members). */
export interface Switchable {
  id: string;
  /** A setting of its own (no switch here), or false: always on. */
  toggle?: string | false;
  defaultOff?: boolean;
  browserRisk?: boolean;
}

/** The module of the features' switches, in their order: each feature
 * without a setting of its own gets plugins.<id>.enabled (on unless
 * defaultOff), one whose content runs on the UI's origin also
 * plugins.<id>.browser, off. */
export function toggles(features: readonly Switchable[]): Module {
  const settings: Record<string, Setting> = {};
  features
    .filter((f) => f.toggle !== false)
    .forEach((f, i) => {
      const order = 10 * (i + 1);
      if (f.toggle === undefined) settings[`plugins.${f.id}.enabled`] = bool({ default: !f.defaultOff, section: 'plugins', order });
      if (f.browserRisk) settings[`plugins.${f.id}.browser`] = bool({ default: false, section: 'plugins', order: order + 5 });
    });
  return Object.keys(settings).length > 0 ? defineModule({ sections: [{ id: 'plugins', order: 65 }], settings }) : {};
}
