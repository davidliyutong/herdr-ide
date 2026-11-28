// The terminals shown last stay mounted while others are shown.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  isKeepableChatLeaf,
  isKeepableFileLeaf,
  keepChatPanes,
  keepFilePanes,
  keepPanes as keep,
  MAX_KEPT_CHAT_PANES,
  MAX_KEPT_FILE_PANES,
  resetKeptPanes,
  type KeptChatPane,
  type KeptFilePane,
  type KeptPane,
} from '../keptPanes';
import type * as L from '../term/layout';

const KEEP_HIDDEN = 6;
const keepPanes = (shown: KeptPane[], open: (k: KeptPane) => boolean, limit = KEEP_HIDDEN) => keep(shown, limit, open);

const rect = { x: 0, y: 0, w: 1, h: 1 };
const p = (pane: string, m = 'm'): KeptPane => ({ m, pane, rect });
const names = (list: KeptPane[]) => list.map((k) => `${k.m}:${k.pane}`);
const all = () => true;

describe('kept panes', () => {
  beforeEach(resetKeptPanes);

  it('keeps the terminals shown before, the latest first, not the ones shown', () => {
    expect(keepPanes([p('a')], all)).toEqual([]);
    expect(names(keepPanes([p('b'), p('c')], all))).toEqual(['m:a']);
    expect(names(keepPanes([p('a')], all))).toEqual(['m:b', 'm:c']);
    // The same address on another machine is another terminal.
    expect(names(keepPanes([p('a', 'n')], all))).toEqual(['m:a', 'm:b', 'm:c']);
  });

  it('drops a terminal that closed and those shown longest ago', () => {
    keepPanes([p('a')], all);
    keepPanes([p('b')], all);
    expect(names(keepPanes([p('c')], (k) => k.pane !== 'a'))).toEqual(['m:b']);
    for (let i = 0; i < KEEP_HIDDEN + 3; i++) keepPanes([p(`t${i}`)], all);
    const kept = keepPanes([p('z')], all);
    expect(kept).toHaveLength(KEEP_HIDDEN);
    expect(kept[0].pane).toBe(`t${KEEP_HIDDEN + 2}`);
    // The setting: fewer are kept at once, and none with 0.
    expect(keepPanes([p('y')], all, 2)).toHaveLength(2);
    expect(keepPanes([p('x')], all, 0)).toEqual([]);
  });
});

describe('kept file panes', () => {
  beforeEach(resetKeptPanes);

  const editorLeaf = (id: string, path: string): L.PluginLeaf => ({ view: { id, plugin: 'files', kind: 'editor', path } });
  const fp = (id: string, path: string, m = 'm'): KeptFilePane => ({ m, pane: `view:${id}`, rect, leaf: editorLeaf(id, path) });

  it('keeps recent file editor panes hidden across tab switches and drops closed ones', () => {
    const open = new Map<string, L.PluginLeaf>([
      ['m:view:a', editorLeaf('a', '/a.ts')],
      ['m:view:b', editorLeaf('b', '/b.md')],
    ]);
    const resolve = (k: KeptFilePane) => open.get(`${k.m}:${k.pane}`) ?? null;
    expect(keepFilePanes([fp('a', '/a.ts')], resolve)).toEqual([]);
    const hidden = keepFilePanes([fp('b', '/b.md')], resolve);
    expect(hidden.map((k) => k.pane)).toEqual(['view:a']);
    // Switching back to a keeps b mounted hidden.
    expect(keepFilePanes([fp('a', '/a.ts')], resolve).map((k) => k.pane)).toEqual(['view:b']);
    // Closing b removes it immediately.
    open.delete('m:view:b');
    expect(keepFilePanes([fp('a', '/a.ts')], resolve)).toEqual([]);
  });

  it('caps kept hidden file panes at MAX_KEPT_FILE_PANES', () => {
    for (let i = 0; i < MAX_KEPT_FILE_PANES + 3; i++) {
      keepFilePanes([fp(`f${i}`, `/${i}.ts`)], (k) => k.leaf);
    }
    const kept = keepFilePanes([fp('cur', '/cur.ts')], (k) => k.leaf);
    expect(kept).toHaveLength(MAX_KEPT_FILE_PANES);
  });

  it('excludes media panes from hidden keeping so audio/video never plays in background tabs', () => {
    expect(isKeepableFileLeaf(editorLeaf('a', '/src/app.ts'))).toBe(true);
    expect(isKeepableFileLeaf(editorLeaf('b', '/docs/README.md'))).toBe(true);
    expect(isKeepableFileLeaf({ preview: { id: 'p1', path: '/notes.txt' } })).toBe(true);
    expect(isKeepableFileLeaf(editorLeaf('m1', '/sound.mp3'))).toBe(false);
    expect(isKeepableFileLeaf(editorLeaf('m2', '/clip.mp4'))).toBe(false);
    expect(isKeepableFileLeaf({ preview: { id: 'p2', path: '/clip.webm' } })).toBe(false);
    expect(isKeepableFileLeaf({ preview: { id: 'p3', path: '/song.wav' } })).toBe(false);
    expect(isKeepableFileLeaf({ preview: { id: 'p4', path: '/photo.png' } })).toBe(false);
    expect(isKeepableFileLeaf({ preview: { id: 'p5', path: '/doc.pdf' } })).toBe(false);
  });
});

describe('kept chat panes', () => {
  beforeEach(resetKeptPanes);

  const chatLeaf = (id: string, chat: string): L.PluginLeaf => ({ view: { id, plugin: 'chat', kind: 'chat', chat, agent: 'claude' } });
  const cp = (id: string, chat: string, m = 'm'): KeptChatPane => ({ m, pane: `view:${id}`, rect, leaf: chatLeaf(id, chat) });

  it('recognizes only chat plugin leaves', () => {
    expect(isKeepableChatLeaf(chatLeaf('a', 'c1'))).toBe(true);
    expect(isKeepableChatLeaf({ view: { id: 'b', plugin: 'files', kind: 'editor', path: '/a.ts' } })).toBe(false);
    expect(isKeepableChatLeaf({ preview: { id: 'p', path: '/a.md' } })).toBe(false);
  });

  it('keeps recent chat panes mounted hidden across switches and drops closed ones immediately', () => {
    const open = new Map<string, L.PluginLeaf>([
      ['m:view:a', chatLeaf('a', 'c1')],
      ['m:view:b', chatLeaf('b', 'c2')],
    ]);
    const resolve = (k: KeptChatPane) => open.get(`${k.m}:${k.pane}`) ?? null;
    expect(keepChatPanes([cp('a', 'c1')], resolve, () => false)).toEqual([]);
    expect(keepChatPanes([cp('b', 'c2')], resolve, () => false).map((k) => k.pane)).toEqual(['view:a']);
    expect(keepChatPanes([cp('a', 'c1')], resolve, () => false).map((k) => k.pane)).toEqual(['view:b']);
    open.delete('m:view:b');
    expect(keepChatPanes([cp('a', 'c1')], resolve, () => false)).toEqual([]);
  });

  it('protects actively working chats from idle LRU eviction while capping idle panes', () => {
    const active = new Set<string>(['view:busy1', 'view:busy2']);
    keepChatPanes(
      [cp('busy1', 'cb1')],
      (k) => k.leaf,
      (k) => active.has(k.pane),
    );
    keepChatPanes(
      [cp('busy2', 'cb2')],
      (k) => k.leaf,
      (k) => active.has(k.pane),
    );
    for (let i = 0; i < MAX_KEPT_CHAT_PANES + 4; i++) {
      keepChatPanes(
        [cp(`idle${i}`, `ci${i}`)],
        (k) => k.leaf,
        (k) => active.has(k.pane),
      );
    }
    const kept = keepChatPanes(
      [cp('cur', 'ccur')],
      (k) => k.leaf,
      (k) => active.has(k.pane),
    );
    const panes = kept.map((k) => k.pane);
    // Both active working chats stay mounted even after more than MAX_KEPT_CHAT_PANES idle chats were opened.
    expect(panes).toContain('view:busy1');
    expect(panes).toContain('view:busy2');
    // Idle panes stay capped at MAX_KEPT_CHAT_PANES so memory stays bounded.
    expect(panes.filter((p) => p.startsWith('view:idle'))).toHaveLength(MAX_KEPT_CHAT_PANES);
  });
});
