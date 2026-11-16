// Selection and keyboard navigation of trees and lists, over the ids of
// the rows shown, in order: what a click with ⌘/Ctrl or Shift selects,
// and what a key does (arrows, pages, Home, End, ← → to collapse, expand
// and go to the parent, Shift to extend, ⌘/Ctrl+A, type-ahead). The
// state stays the caller's (the file explorer keeps it in its store);
// these functions return the next one.

import { isMac } from '../../keys';

export interface Selection {
  /** The selected ids, in the order they were selected. */
  selection: string[];
  /** The row the keyboard is on. */
  cursor?: string;
  /** Where a range (Shift) starts. */
  anchor?: string;
}

/** The ids from a to b, in the rows' order; [b] when either is not shown. */
export function rangeOf(ids: readonly string[], a: string, b: string): string[] {
  const i = ids.indexOf(a);
  const j = ids.indexOf(b);
  if (i < 0 || j < 0) return [b];
  return i < j ? ids.slice(i, j + 1) : ids.slice(j, i + 1);
}

/** id alone (a click). */
export function selectOnly(id: string): Selection {
  return { selection: [id], cursor: id, anchor: id };
}

/** id added or removed (⌘/Ctrl+click). */
export function selectToggle(s: Selection, id: string): Selection {
  const has = s.selection.includes(id);
  return { selection: has ? s.selection.filter((x) => x !== id) : [...s.selection, id], cursor: id, anchor: id };
}

/** The rows from the anchor to id (Shift+click, Shift+arrows); id alone
 * without an anchor. */
export function selectRange(s: Selection, ids: readonly string[], id: string): Selection {
  if (!s.anchor) return selectOnly(id);
  return { selection: rangeOf(ids, s.anchor, id), cursor: id, anchor: s.anchor };
}

/** Every row (⌘/Ctrl+A); the cursor stays. */
export function selectAll(s: Selection, ids: readonly string[]): Selection {
  return { selection: [...ids], cursor: s.cursor ?? ids[0], anchor: s.anchor ?? ids[0] };
}

/** How a click with these modifiers selects: ⌘ (Ctrl elsewhere) toggles,
 * Shift extends. */
export function clickSelection(ev: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }, mac = isMac): 'only' | 'toggle' | 'range' {
  if (ev.shiftKey) return 'range';
  return (mac ? ev.metaKey : ev.ctrlKey) ? 'toggle' : 'only';
}

/** The id delta rows from cursor, kept within the rows; the first (going
 * down) or the last (going up) without a cursor shown. */
export function stepId(ids: readonly string[], cursor: string | undefined, delta: number): string | undefined {
  if (!ids.length) return undefined;
  const i = cursor === undefined ? -1 : ids.indexOf(cursor);
  if (i < 0) return delta > 0 ? ids[0] : ids[ids.length - 1];
  return ids[Math.max(0, Math.min(ids.length - 1, i + delta))];
}

/** A row as the keyboard sees it. */
export interface NavRow {
  id: string;
  /** The row ← goes to (its folder), when it is shown. */
  parent?: string;
  /** Whether a branch is expanded; undefined for a leaf. */
  expanded?: boolean;
  /** What type-ahead matches (its name). */
  label?: string;
  /** Not a row the keyboard stops on (a name being typed). */
  skip?: boolean;
}

/** What a key does: move the cursor (extend: from the anchor), expand or
 * collapse a branch, select every row, or nothing though the key is the
 * tree's (→ on a leaf). */
export type NavAction =
  | { kind: 'move'; to: string; extend: boolean }
  | { kind: 'expand'; id: string }
  | { kind: 'collapse'; id: string }
  | { kind: 'selectAll' }
  | { kind: 'none' };

export interface NavOptions {
  /** Rows a page moves (PgUp, PgDn): those in view less one. */
  page?: number;
  /** Several rows can be selected (Shift extends, ⌘/Ctrl+A). */
  multi?: boolean;
  /** Typed letters go to the next row whose label starts with them. */
  typeahead?: TypeAhead;
  mac?: boolean;
}

export interface KeyLike {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

/** What key does in rows (in order) with the cursor on cursor; undefined
 * for a key that is not the tree's (the caller's own keys: Enter, Space,
 * F2, Delete; the page's shortcuts with ⌘, Ctrl or Alt). */
export function navigationKey(ev: KeyLike, rows: readonly NavRow[], cursor: string | undefined, o: NavOptions = {}): NavAction | undefined {
  const mac = o.mac ?? isMac;
  const ids = rows.filter((r) => !r.skip).map((r) => r.id);
  const extend = !!o.multi && ev.shiftKey;
  const move = (to: string | undefined): NavAction => (to === undefined ? { kind: 'none' } : { kind: 'move', to, extend });
  const plain = !ev.metaKey && !ev.ctrlKey && !ev.altKey;
  const page = Math.max(1, o.page ?? 10);
  if (plain) {
    switch (ev.key) {
      case 'ArrowDown':
        return move(stepId(ids, cursor, 1));
      case 'ArrowUp':
        return move(stepId(ids, cursor, -1));
      case 'PageDown':
        return move(stepId(ids, cursor, page));
      case 'PageUp':
        return move(stepId(ids, cursor, -page));
      case 'Home':
        return move(ids[0]);
      case 'End':
        return move(ids[ids.length - 1]);
      case 'ArrowRight': {
        const row = rows.find((r) => r.id === cursor);
        if (!row || row.expanded === undefined) return { kind: 'none' };
        if (!row.expanded) return { kind: 'expand', id: row.id };
        const child = rows.find((r) => r.parent === row.id && !r.skip);
        return child ? { kind: 'move', to: child.id, extend: false } : { kind: 'none' };
      }
      case 'ArrowLeft': {
        const row = rows.find((r) => r.id === cursor);
        if (!row) return { kind: 'none' };
        if (row.expanded) return { kind: 'collapse', id: row.id };
        const up = row.parent !== undefined && rows.find((r) => r.id === row.parent && !r.skip);
        return up ? { kind: 'move', to: up.id, extend: false } : { kind: 'none' };
      }
    }
  }
  const mod = mac ? ev.metaKey && !ev.ctrlKey : ev.ctrlKey && !ev.metaKey;
  if (o.multi && mod && !ev.altKey && !ev.shiftKey && ev.key.toLowerCase() === 'a') return { kind: 'selectAll' };
  if (o.typeahead && plain && ev.key.length === 1 && (ev.key !== ' ' || o.typeahead.active())) {
    const to = o.typeahead.next(ev.key, rows, cursor);
    return to === undefined ? { kind: 'none' } : { kind: 'move', to, extend: false };
  }
  return undefined;
}

/** Type-ahead: letters typed within a moment of each other name a row;
 * the same letter again goes to the next row starting with it. */
export class TypeAhead {
  private typed = '';
  private last = -Infinity;
  private readonly timeout: number;
  /** timeout: the milliseconds after which typing starts afresh. */
  constructor(timeout = 800) {
    this.timeout = timeout;
  }

  /** Whether letters typed now continue the last ones. */
  active(now = Date.now()): boolean {
    return this.typed !== '' && now - this.last <= this.timeout;
  }

  /** The row the letters typed so far, then ch, name: the first from the
   * cursor on whose label starts with them (after the cursor when the
   * same letter is typed again); undefined when none does. */
  next(ch: string, rows: readonly NavRow[], cursor: string | undefined, now = Date.now()): string | undefined {
    if (!this.active(now)) this.typed = '';
    this.typed += ch.toLowerCase();
    this.last = now;
    const same = [...this.typed].every((c) => c === this.typed[0]);
    const prefix = same ? this.typed[0] : this.typed;
    const list = rows.filter((r) => !r.skip && r.label !== undefined);
    if (!list.length) return undefined;
    const at = Math.max(
      0,
      list.findIndex((r) => r.id === cursor),
    );
    const start = same && list[at]?.id === cursor ? at + 1 : at;
    for (let i = 0; i < list.length; i++) {
      const r = list[(start + i) % list.length];
      if (r.label!.toLowerCase().startsWith(prefix)) return r.id;
    }
    return undefined;
  }

  reset() {
    this.typed = '';
  }
}
