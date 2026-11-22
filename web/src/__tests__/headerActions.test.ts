// @vitest-environment jsdom
//
// The buttons plugins add to a terminal pane's header
// (TerminalHeaderActions): nothing without a plugin that is on and has
// some, each plugin's in its error boundary otherwise, given the pane's
// machine, terminal and leaf; a press on one leaves the keyboard where it
// is.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Bot } from 'lucide-react';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import { useSettings } from '../settings';
import { allPlugins, definePlugins, TerminalHeaderActions } from '../plugins/registry';
import type { PluginDef, TerminalHeaderProps } from '../plugins/api';
import { fakeSettingsApi } from './fakeSettings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let broken = false;
const Button = ({ m, terminal, leaf }: TerminalHeaderProps) => {
  if (broken) throw new Error('kaput');
  return createElement('button', { className: 'header-button', 'data-for': `${m}/${terminal}/${leaf.terminal}` }, terminal);
};
const withButtons: PluginDef = { id: 'buttons', title: 'agents.title', icon: Bot, headerActions: [Button] };
const plain: PluginDef = { id: 'plain', title: 'history.title', icon: Bot };
const props: TerminalHeaderProps = { m: 'a', terminal: 't1', leaf: { terminal: 't1' } };

describe('terminal header actions', () => {
  let host: HTMLDivElement;
  let root: Root;
  const saved = [...allPlugins()];

  beforeEach(() => {
    fakeSettingsApi();
    useSettings.setState({ values: {} });
    broken = false;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    definePlugins(saved);
    vi.restoreAllMocks();
  });

  const draw = () => act(() => root.render(createElement('div', null, createElement(TerminalHeaderActions, props))));

  it('draw nothing while no plugin that is on has any', async () => {
    definePlugins([plain]);
    await draw();
    expect(host.firstElementChild!.childNodes.length).toBe(0);
    definePlugins([plain, withButtons]);
    useSettings.setState({ values: { 'plugins.buttons.enabled': { value: false, source: 'global' } } });
    await draw();
    expect(host.firstElementChild!.childNodes.length).toBe(0);
  });

  it('draw each plugin’s buttons for the pane, a press leaving the keyboard where it is', async () => {
    definePlugins([plain, withButtons]);
    await draw();
    const actions = host.querySelector('.pane-plugin-actions')!;
    expect(actions.querySelector('.header-button')!.getAttribute('data-for')).toBe('a/t1/t1');
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    actions.querySelector('button')!.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    // A press beside the buttons is the header's.
    const beside = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    actions.dispatchEvent(beside);
    expect(beside.defaultPrevented).toBe(false);
  });

  it('show a plugin’s buttons that fail in their place, the rest of the page going on', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const other: PluginDef = {
      id: 'other',
      title: 'history.title',
      icon: Bot,
      headerActions: [() => createElement('button', { className: 'fine' })],
    };
    definePlugins([withButtons, other]);
    broken = true;
    await draw();
    expect(host.querySelector('.pane-plugin-actions .plugin-error-item')).not.toBeNull();
    expect(host.querySelector('.pane-plugin-actions .fine')).not.toBeNull();
  });
});
