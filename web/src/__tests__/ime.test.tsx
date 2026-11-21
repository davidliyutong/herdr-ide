// @vitest-environment jsdom
// Keys an input method takes are its own: Enter that commits the letters
// typed with a Chinese input method does not also end a rename.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { InlineEdit } from '../components/InlineEdit';
import { guardImeKeys, imeKey } from '../ime';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const key = (el: Element, init: KeyboardEventInit) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));

describe('input method keys', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('knows a composing keydown by its flag or its key code', () => {
    expect(imeKey({ isComposing: true, keyCode: 13 })).toBe(true);
    expect(imeKey({ isComposing: false, keyCode: 229 })).toBe(true);
    expect(imeKey({ isComposing: false, keyCode: 13 })).toBe(false);
  });

  it('leaves a rename open on the Enter that commits a composition', async () => {
    const done = vi.fn();
    await act(async () => root.render(createElement(InlineEdit, { value: 'old', onDone: done })));
    const input = host.querySelector('input')!;
    input.value = 'my tab';
    await act(async () => void key(input, { key: 'Enter', isComposing: true }));
    await act(async () => void key(input, { key: 'Enter', keyCode: 229 }));
    await act(async () => void key(input, { key: 'Escape', isComposing: true }));
    expect(done).not.toHaveBeenCalled();
    input.value = 'mytab';
    await act(async () => void key(input, { key: 'Enter' }));
    expect(done).toHaveBeenCalledWith('mytab');
  });

  it('keeps composing keys of text fields from the page, not those of a terminal', () => {
    const off = guardImeKeys();
    const seen: string[] = [];
    const listen = (e: Event) => seen.push((e.target as HTMLElement).className);
    document.addEventListener('keydown', listen);
    const field = Object.assign(document.createElement('input'), { className: 'field' });
    const term = document.createElement('div');
    term.className = 'term-host';
    const ta = Object.assign(document.createElement('textarea'), { className: 'term-input' });
    term.append(ta);
    host.append(field, term);
    key(field, { key: 'Enter', isComposing: true });
    key(ta, { key: 'Enter', isComposing: true });
    key(field, { key: 'Enter' });
    expect(seen).toEqual(['term-input', 'field']);
    off();
    key(field, { key: 'Enter', isComposing: true });
    expect(seen).toHaveLength(3);
    document.removeEventListener('keydown', listen);
  });
});
