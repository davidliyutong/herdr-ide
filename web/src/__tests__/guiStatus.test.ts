// @vitest-environment jsdom
//
// A machine's display state in the settings names the kind of display that
// draws with the GPU and, on machines with several NVIDIA GPUs, the one
// windows of Vulkan programs come from.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { api: () => Promise.resolve({}), setTheme: () => {} } }));

import { GuiMachineStatus } from '../gui/GuiMenus';
import { useGui, type GuiState } from '../gui/state';
import { setLocale } from '../i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = '';
  useGui.setState({ machines: {}, dismissed: {} });
});

function render(st: Partial<GuiState>) {
  setLocale('en');
  useGui.setState({ machines: { ws2: { m: 'ws2', phase: 'ready', windows: [], ...st } } });
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(createElement(GuiMachineStatus, { m: 'ws2' })));
  return host;
}

describe('display state', () => {
  it('is plain for a display in memory', () => {
    expect(render({ display: 'xvfb' }).textContent).toBe('Ready');
  });

  it('names the GPU display and VirtualGL', () => {
    expect(render({ display: 'xwayland', gpu: true }).textContent).toBe('Ready · GPU display · VirtualGL');
  });

  it('names the GPU that Vulkan windows come from, and why in its tooltip', () => {
    const host = render({ display: 'xwayland', vulkan_gpu: 1 });
    expect(host.textContent).toBe('Ready · GPU display · Vulkan windows from GPU 1 only');
    const hint = host.querySelector<HTMLElement>('[data-vulkan-gpu]')!;
    expect(hint.dataset.vulkanGpu).toBe('1');
    expect(hint.title).toContain('CUDA_VISIBLE_DEVICES');
  });

  it('says that programs choose the GPU when the setting is on', () => {
    const host = render({ display: 'xvfb', vulkan_gpu: 0, pick: true });
    expect(host.textContent).toBe('Ready · Vulkan windows from GPU 0 or CUDA_VISIBLE_DEVICES');
  });

  it('says nothing of GPUs while the display is not ready', () => {
    expect(render({ phase: 'starting', display: 'xwayland', gpu: true, vulkan_gpu: 1 }).textContent).toBe('Starting');
  });
});
