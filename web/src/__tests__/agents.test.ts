// The agents plugin on the page (plugins/agents): its switch, which turns
// the machines' session detection on and off (the core's side), and one
// button in terminals' headers (Continue in Chat, chatImport.test.tsx); no
// commands, no new-tab items.

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import registry from '../../../spec/generated/registry.json';
import { agentsPlugin } from '../plugins/agents';
import { allPlugins, definePlugins, enableSetting, newTabGroups, pluginOn } from '../plugins/registry';
import { useSettings } from '../settings';

const saved = [...allPlugins()];
afterEach(() => {
  definePlugins(saved);
  useSettings.setState({ values: {} });
});

describe('the agents plugin', () => {
  it('is its switch, on by default', () => {
    expect(agentsPlugin.id).toBe('agents');
    expect(enableSetting(agentsPlugin, 'browser')).toBe('plugins.agents.enabled');
    expect(enableSetting(agentsPlugin, 'desktop')).toBe('plugins.agents.enabled');
    useSettings.setState({ values: {} });
    expect(pluginOn(agentsPlugin)).toBe(true);
    useSettings.setState({ values: { 'plugins.agents.enabled': { value: false, source: 'global' } } as never });
    expect(pluginOn(agentsPlugin)).toBe(false);
  });

  it('adds no commands or new-tab items, and one header button', () => {
    const { commands, newTabItems, headerActions, panels, paneViews, statusItems } = agentsPlugin;
    expect({ commands, newTabItems, panels, paneViews, statusItems }).toEqual({});
    expect(headerActions).toHaveLength(1);
    expect(registry.commands.filter((c) => c.id.startsWith('agents.'))).toEqual([]);
    definePlugins([agentsPlugin]);
    expect(newTabGroups('a')).toEqual([]);
  });
});
