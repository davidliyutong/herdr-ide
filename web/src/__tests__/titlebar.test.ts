// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { applyTitlebar, initDesktop } from '../desktop';
import type { DesktopShell } from '../shell';
import { useSettings } from '../settings';

function makeShell(withTitlebar: boolean) {
  let fullScreenFn: ((full: boolean) => void) | undefined;
  let unsubscribed = false;
  const shell: DesktopShell = {
    onCommand: () => () => {},
    pathForFile: () => '',
    onOpenFolders: () => () => {},
    setDisabledCommands: () => {},
    setUnsaved: () => {},
    onCloseRequest: () => () => {},
    answerClose: () => {},
    ...(withTitlebar && {
      titlebar: {
        kind: 'mac',
        inset: 84,
        minHeight: 44,
        topSpace: 4,
        onFullScreen(fn) {
          fullScreenFn = fn;
          return () => {
            unsubscribed = true;
            fullScreenFn = undefined;
          };
        },
      },
    }),
  };
  return {
    shell,
    emitFullScreen: (v: boolean) => fullScreenFn?.(v),
    isUnsubscribed: () => unsubscribed,
  };
}

describe('integrated macOS title bar', () => {
  afterEach(() => {
    applyTitlebar(undefined);
    useSettings.setState((s) => ({
      values: { ...s.values, 'window.zoom': { value: 100, source: 'default' } },
    }));
  });

  it('sets root attributes and CSS variables for macOS desktop and tracks zoom and full screen', () => {
    const { shell, emitFullScreen, isUnsubscribed } = makeShell(true);
    const stop = initDesktop(shell);
    const root = document.documentElement;
    expect(root.dataset.titlebar).toBe('mac');
    expect(root.style.getPropertyValue('--titlebar-inset-px')).toBe('84px');
    expect(root.style.getPropertyValue('--titlebar-min-h-px')).toBe('44px');
    expect(root.style.getPropertyValue('--titlebar-top-px')).toBe('4px');
    expect(root.style.getPropertyValue('--desktop-zoom')).toBe('1');
    expect(root.dataset.fullscreen).toBeUndefined();

    // Changing window.zoom updates --desktop-zoom so traffic light inset stays fixed in window points.
    useSettings.setState((s) => ({
      values: { ...s.values, 'window.zoom': { value: 150, source: 'global' } },
    }));
    expect(root.style.getPropertyValue('--desktop-zoom')).toBe('1.5');

    // Entering and leaving macOS full screen toggles data-fullscreen.
    emitFullScreen(true);
    expect(root.dataset.fullscreen).toBe('true');
    emitFullScreen(false);
    expect(root.dataset.fullscreen).toBeUndefined();

    stop();
    expect(isUnsubscribed()).toBe(true);
  });

  it('clears titlebar attributes in browser or native-frame platforms', () => {
    const mac = makeShell(true);
    applyTitlebar(mac.shell);
    expect(document.documentElement.dataset.titlebar).toBe('mac');

    const win = makeShell(false);
    applyTitlebar(win.shell);
    expect(document.documentElement.dataset.titlebar).toBeUndefined();
    expect(document.documentElement.style.getPropertyValue('--titlebar-inset-px')).toBe('');
  });
});
