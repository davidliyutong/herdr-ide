// Searchable dropdowns, as VS Code's quick picks: a list with a search
// field that filters as one types (the command palette's matcher,
// lib/match.ts, with the matched characters marked), groups under
// headers, per-item icons, descriptions and details, disabled items, an
// optional row that creates what the query names, and single or multiple
// choice (check boxes, select all shown, clear). Long lists stay fast:
// only the rows in view are drawn (lib/windowed.ts).
//
// Two forms: <Picker>, a button showing the current value(s) that opens
// the list below it (where a <select> would be), and pick() / pickMany(),
// which open the list at an element or a point and resolve with the
// choice. The list is placed within the window (below its anchor, above
// when there is more room there, as wide as the window less a gutter on
// phones), closes on Escape (focus goes back) or a press outside, and keeps
// the keys while open: typing filters, ↑ ↓ PgUp PgDn Home End move, Enter
// chooses (with several, accepts), Space toggles with several (once an
// arrow moved, or while the query is empty; otherwise it types a space).

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { Check, ChevronDown, Plus } from 'lucide-react';
import { match, type MatchRange } from '../lib/match';
import { revealTop, rowOffsets, visibleRows } from '../lib/windowed';
import { useSize } from '../lib/sizes';
import { t } from '../i18n';
import { Highlight } from './Highlight';
import { useDismiss } from './useDismiss';

export interface PickerItem<V extends string = string> {
  value: V;
  label: string;
  /** Muted text after the label (a branch's upstream, a path). */
  description?: string;
  /** A second line (a commit's subject). */
  detail?: string;
  icon?: ReactNode;
  /** The header it is listed under; groups keep the order of their first
   * item (local branches, then each remote's). */
  group?: string;
  disabled?: boolean;
  /** More text the search matches, not shown. */
  keywords?: string;
}

export interface PickerOptions<V extends string = string> {
  items: readonly PickerItem<V>[];
  /** The search field's placeholder. */
  placeholder?: string;
  /** Shown when no item matches (and there is no row to create one). */
  emptyText?: string;
  /** The label of a row that creates what the query names ("Create
   * branch 'foo'"); undefined for none (an invalid name). Not offered for
   * a query that is an item's label. */
  create?(query: string): string | undefined;
  /** Keep the items' order while filtering (else the best matches first,
   * within each group). */
  keepOrder?: boolean;
  /** The list's accessible name. */
  label?: string;
}

// ---- rows ----

export type PickerRow<V extends string = string> =
  | { kind: 'group'; label: string }
  | { kind: 'create'; label: string; query: string }
  | { kind: 'item'; item: PickerItem<V>; ranges?: MatchRange[]; descriptionRanges?: MatchRange[] };

/** The rows a query shows: the create row first, then each group's
 * header and matching items (the best first unless keepOrder). An item
 * matches by its label, else (ranked below) by its description, detail or
 * keywords. */
export function pickerRows<V extends string>(
  items: readonly PickerItem<V>[],
  query: string,
  o: Pick<PickerOptions<V>, 'create' | 'keepOrder'> = {},
): PickerRow<V>[] {
  const q = query.trim();
  const groups = new Map<string | undefined, Array<{ row: PickerRow<V>; rank: number }>>();
  for (const item of items) if (!groups.has(item.group)) groups.set(item.group, []);
  for (const item of items) {
    let row: PickerRow<V> | undefined;
    let rank = 0;
    if (!q) row = { kind: 'item', item };
    else {
      const m = match(q, item.label);
      if (m) {
        row = { kind: 'item', item, ranges: m.ranges };
        rank = 3 + m.score;
      } else {
        const other = match(q, [item.description, item.detail, item.keywords].filter(Boolean).join(' '));
        if (other) {
          row = { kind: 'item', item, descriptionRanges: item.description ? match(q, item.description)?.ranges : undefined };
          rank = other.score;
        }
      }
    }
    if (row) groups.get(item.group)!.push({ row, rank });
  }
  const out: PickerRow<V>[] = [];
  const label = q && o.create && !items.some((i) => i.label === q) ? o.create(q) : undefined;
  if (label) out.push({ kind: 'create', label, query: q });
  for (const [group, list] of groups) {
    if (!list.length) continue;
    if (group) out.push({ kind: 'group', label: group });
    if (q && !o.keepOrder) list.sort((a, b) => b.rank - a.rank);
    for (const { row } of list) out.push(row);
  }
  return out;
}

const selectable = (r: PickerRow | undefined) => !!r && (r.kind === 'create' || (r.kind === 'item' && !r.item.disabled));
const rowKey = (r: PickerRow | undefined) => (r?.kind === 'create' ? '\0create' : r?.kind === 'item' ? r.item.value : undefined);

/** The selectable row delta steps from i (kept within the rows). */
function stepRow(rows: readonly PickerRow[], i: number, delta: number): number {
  const sel = rows.map((r, k) => (selectable(r) ? k : -1)).filter((k) => k >= 0);
  if (!sel.length) return -1;
  if (i < 0) return delta > 0 ? sel[0] : sel[sel.length - 1];
  let at = sel.findIndex((k) => k >= i);
  if (at < 0) at = sel.length - 1;
  return sel[Math.max(0, Math.min(sel.length - 1, at + delta))];
}

// ---- placement ----

export interface AnchorRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** An element, or a point (a pointer's position) and the size there. */
export type PickAnchor = Element | { x: number; y: number; width?: number; height?: number };

function rectOf(a: PickAnchor): AnchorRect {
  if (a instanceof Element) return a.getBoundingClientRect();
  return { left: a.x, top: a.y, right: a.x + (a.width ?? 0), bottom: a.y + (a.height ?? 0) };
}

/** The gutter kept from the window's edges. */
const MARGIN = 8;
/** The widest list, and the narrowest unless the window is narrower. */
const MAX_WIDTH = 480;
const MIN_WIDTH = 260;
/** A window this narrow (a phone) gets lists as wide as itself less the gutters. */
const PHONE_WIDTH = 480;

/** Where a list of the wanted height goes beside anchor in a view: below
 * it (top), or above (bottom, from the view's bottom edge) when it does
 * not fit below and there is more room above;
 * its left edge at the anchor's, moved into the view; as wide as the
 * anchor (between MIN_WIDTH and MAX_WIDTH, at most the view less the
 * gutters; on a phone the view less the gutters). maxHeight is the room
 * it has. */
export function placeList(anchor: AnchorRect, wanted: number, view: { width: number; height: number }) {
  const width =
    view.width <= PHONE_WIDTH
      ? view.width - 2 * MARGIN
      : Math.min(Math.max(anchor.right - anchor.left, MIN_WIDTH), MAX_WIDTH, view.width - 2 * MARGIN);
  const left = Math.max(MARGIN, Math.min(anchor.left, view.width - width - MARGIN));
  const below = view.height - anchor.bottom - MARGIN - 2;
  const above = anchor.top - MARGIN - 2;
  if (wanted <= below || below >= above) return { left, width, top: anchor.bottom + 2, maxHeight: Math.max(0, below) };
  // Above: its bottom edge at the anchor's top, whatever height it takes.
  return { left, width, bottom: view.height - anchor.top + 2, maxHeight: above };
}

// ---- the list ----

interface ListProps<V extends string> extends PickerOptions<V> {
  anchor: PickAnchor;
  multiple: boolean;
  selected: readonly V[];
  /** Presses on it are not outside (the button that opened the list). */
  owner?: RefObject<HTMLElement | null>;
  /** One item chosen (single). */
  onChoose(value: V): void;
  /** The selection changed (multiple). */
  onSelect(values: V[]): void;
  onCreate(query: string): void;
  /** Accepted (multiple: Enter, Done). */
  onDone(): void;
  /** Escape, a press outside, the keyboard leaving. */
  onCancel(): void;
}

const coarsePointer = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

function PickerList<V extends string>(p: ListProps<V>) {
  const [query, setQuery] = useState('');
  const rows = useMemo(() => pickerRows(p.items, query, p), [p.items, query, p.create, p.keepOrder]);
  const selected = useMemo(() => new Set<string>(p.selected), [p.selected]);
  // The keyboard's row, by its value so that it stays on its item when the
  // items change (a change of the selection may build them anew); the
  // first one while none is set: the current value (single, no query),
  // else the first match, the create row when nothing else matches.
  const [activeKey, setActiveKey] = useState<string>();
  const first = useMemo(() => {
    let i = -1;
    if (!query && !p.multiple && p.selected.length) i = rows.findIndex((r) => r.kind === 'item' && r.item.value === p.selected[0]);
    if (i < 0 || !selectable(rows[i])) i = rows.findIndex((r) => r.kind === 'item' && !r.item.disabled);
    return i < 0 ? stepRow(rows, -1, 1) : i;
  }, [rows]);
  const found = activeKey === undefined ? -1 : rows.findIndex((r) => rowKey(r) === activeKey);
  const active = found >= 0 ? found : first;
  const setActive = (i: number) => setActiveKey(i >= 0 ? rowKey(rows[i]) : undefined);
  // Space toggles once arrows moved (or with no query).
  const navigating = useRef(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [place, setPlace] = useState<ReturnType<typeof placeList>>();
  const [chrome, setChrome] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const returnTo = useRef<Element | null>(null);
  const reveal = useRef(true);
  const id = useId();

  // Rows' heights: touch screens get taller items.
  const base = useSize('row');
  const itemPx = coarsePointer() ? Math.round(base * 1.5) : base;
  const detailPx = Math.round(itemPx * 1.75);
  const heights = useMemo(
    () => rows.map((r) => (r.kind === 'item' && r.item.detail ? detailPx : r.kind === 'group' ? base : itemPx)),
    [rows, base, itemPx, detailPx],
  );
  const offsets = useMemo(() => rowOffsets(heights), [heights]);
  const total = offsets[offsets.length - 1];
  const wantedList = rows.length ? Math.min(total, base * 12) : base * 1.5;

  useEffect(() => {
    returnTo.current = p.owner?.current ?? document.activeElement;
    input.current?.focus({ preventScroll: true });
  }, []);

  // Placed within the window; again when it changes or scrolls.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const again = () => setTick((n) => n + 1);
    window.addEventListener('resize', again);
    window.addEventListener('scroll', again, true);
    return () => {
      window.removeEventListener('resize', again);
      window.removeEventListener('scroll', again, true);
    };
  }, []);
  useLayoutEffect(() => {
    const el = box.current;
    const c = el && list.current ? el.offsetHeight - list.current.offsetHeight : 0;
    if (c !== chrome) setChrome(c);
    const next = placeList(rectOf(p.anchor), c + wantedList, { width: window.innerWidth, height: window.innerHeight });
    setPlace((cur) => (cur && JSON.stringify(cur) === JSON.stringify(next) ? cur : next));
  }, [p.anchor, wantedList, tick, chrome]);
  const listHeight = Math.max(base, Math.min(wantedList, (place?.maxHeight ?? Infinity) - chrome));

  // The keyboard's row in view.
  useLayoutEffect(() => {
    const el = list.current;
    if (!reveal.current || !el || active < 0) return;
    reveal.current = false;
    const top = revealTop(el.scrollTop, listHeight, offsets[active], offsets[active + 1]);
    if (top !== el.scrollTop) {
      el.scrollTop = top;
      setScrollTop(top);
    }
  }, [active, offsets, listHeight]);

  const finish = (f: () => void) => {
    f();
    if (returnTo.current instanceof HTMLElement && returnTo.current.isConnected) returnTo.current.focus({ preventScroll: true });
  };
  useDismiss(true, box, p.onCancel, p.owner);

  const values = (set: Set<string>): V[] => {
    const inItems = p.items.filter((i) => set.has(i.value)).map((i) => i.value);
    return [...inItems, ...p.selected.filter((v) => !inItems.includes(v) && set.has(v))];
  };
  const toggle = (v: V) => {
    const next = new Set(selected);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    p.onSelect(values(next));
  };
  const shown = rows.flatMap((r) => (r.kind === 'item' && !r.item.disabled ? [r.item.value] : []));
  const run = (i: number) => {
    const r = rows[i];
    if (!selectable(r)) return;
    if (r.kind === 'create') {
      if (p.multiple) {
        p.onCreate(r.query);
        setQuery('');
      } else finish(() => p.onCreate(r.query));
    } else if (r.kind === 'item') {
      if (p.multiple) toggle(r.item.value);
      else finish(() => p.onChoose(r.item.value));
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Keys stay in the list: no shortcuts of the page while it is open.
    e.stopPropagation();
    const inField = e.target === input.current;
    const page = Math.max(1, Math.floor(listHeight / itemPx) - 1);
    const go = (i: number) => {
      e.preventDefault();
      navigating.current = true;
      reveal.current = true;
      setActive(i);
    };
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        return finish(p.onCancel);
      case 'ArrowDown':
        return go(stepRow(rows, active, 1));
      case 'ArrowUp':
        return go(stepRow(rows, active, -1));
      case 'PageDown':
        return go(stepRow(rows, active, page));
      case 'PageUp':
        return go(stepRow(rows, active, -page));
      case 'Home':
        return inField ? go(stepRow(rows, -1, 1)) : undefined;
      case 'End':
        return inField ? go(stepRow(rows, -1, -1)) : undefined;
      case 'Tab':
        // A single choice closes as a <select> does; several go on to the footer.
        if (p.multiple) return;
        e.preventDefault();
        return finish(p.onCancel);
      case 'Enter':
        if (!inField) return;
        e.preventDefault();
        if (p.multiple && rows[active]?.kind !== 'create') return finish(p.onDone);
        return run(active);
      case ' ':
        if (!inField || !p.multiple || (query && !navigating.current)) return;
        e.preventDefault();
        return run(active);
    }
  };

  const [from, to] = visibleRows(offsets, scrollTop, listHeight);
  const optionId = (i: number) => `${id}-o${i}`;
  const options = rows.filter((r) => r.kind !== 'group').length;
  let pos = rows.slice(0, from).filter((r) => r.kind !== 'group').length;

  return createPortal(
    <div
      ref={box}
      className="picker"
      style={place ? { ...place } : { visibility: 'hidden' }}
      onKeyDown={onKeyDown}
      onBlur={(e) => {
        // The keyboard left (Tab): closed. A press on the owner toggles it.
        const to = e.relatedTarget as Node | null;
        if (to && !box.current?.contains(to) && !p.owner?.current?.contains(to)) p.onCancel();
      }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <input
        ref={input}
        className="picker-search"
        type="text"
        role="combobox"
        aria-expanded
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? optionId(active) : undefined}
        aria-label={p.label ?? p.placeholder ?? t('picker.search')}
        placeholder={p.placeholder ?? t('picker.search')}
        spellCheck={false}
        autoComplete="off"
        value={query}
        onChange={(e) => {
          navigating.current = false;
          reveal.current = true;
          setActiveKey(undefined);
          setQuery(e.target.value);
        }}
      />
      <div
        ref={list}
        id={`${id}-list`}
        className="picker-list"
        role="listbox"
        aria-label={p.label ?? p.placeholder ?? t('picker.search')}
        aria-multiselectable={p.multiple || undefined}
        style={{ height: listHeight }}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onMouseDown={(e) => e.preventDefault()}
      >
        {rows.length === 0 ? (
          <div className="picker-empty muted">{p.emptyText ?? t('picker.noMatch')}</div>
        ) : (
          <div className="picker-rows" style={{ height: total }}>
            {rows.slice(from, to).map((r, k) => {
              const i = from + k;
              const style = { top: offsets[i], height: heights[i] };
              if (r.kind === 'group') {
                return (
                  <div key={`g:${r.label}`} className="picker-group" style={style} role="presentation">
                    <span className="ellipsis">{r.label}</span>
                  </div>
                );
              }
              pos++;
              const on = r.kind === 'item' && selected.has(r.item.value);
              const disabled = r.kind === 'item' && !!r.item.disabled;
              return (
                <div
                  key={r.kind === 'create' ? 'create' : `i:${r.item.value}`}
                  id={optionId(i)}
                  className={[
                    'picker-row',
                    i === active && 'active',
                    disabled && 'disabled',
                    r.kind === 'item' && r.item.detail && 'two-line',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  style={style}
                  role="option"
                  aria-selected={on}
                  aria-disabled={disabled || undefined}
                  aria-setsize={options}
                  aria-posinset={pos}
                  onPointerMove={() => selectable(r) && i !== active && setActive(i)}
                  onClick={() => run(i)}
                >
                  {r.kind === 'create' ? (
                    <>
                      <Plus className="picker-icon" />
                      <span className="picker-label ellipsis">{r.label}</span>
                    </>
                  ) : (
                    <>
                      {p.multiple && <span className={`picker-check ${on ? 'on' : ''}`}>{on && <Check />}</span>}
                      {r.item.icon && <span className="picker-icon">{r.item.icon}</span>}
                      <span className="picker-text">
                        <span className="picker-line">
                          <span className="picker-label ellipsis">
                            <Highlight text={r.item.label} ranges={r.ranges} />
                          </span>
                          {r.item.description && (
                            <span className="picker-description ellipsis">
                              <Highlight text={r.item.description} ranges={r.descriptionRanges} />
                            </span>
                          )}
                        </span>
                        {r.item.detail && <span className="picker-detail ellipsis">{r.item.detail}</span>}
                      </span>
                      {!p.multiple && on && <Check className="picker-current" />}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {p.multiple && (
        <div className="picker-footer">
          <span className="muted ellipsis">{t('picker.selected', { count: selected.size })}</span>
          <span className="spacer" />
          <button
            type="button"
            className="ghost sm"
            disabled={!shown.length}
            onClick={() => p.onSelect(values(new Set([...selected, ...shown])))}
          >
            {t('picker.selectShown')}
          </button>
          <button type="button" className="ghost sm" disabled={!selected.size} onClick={() => p.onSelect([])}>
            {t('picker.clear')}
          </button>
          <button type="button" className="primary sm" onClick={() => finish(p.onDone)}>
            {t('picker.done')}
          </button>
        </div>
      )}
    </div>,
    document.body,
  );
}

// ---- the button form ----

interface ButtonProps<V extends string> extends PickerOptions<V> {
  /** What the button says when nothing is chosen. */
  noneLabel?: string;
  /** Called with the query of the create row (create gives its label). */
  onCreate?(query: string): void;
  disabled?: boolean;
  className?: string;
  /** The button's accessible name (the setting it chooses). */
  'aria-label'?: string;
}

export interface SinglePickerProps<V extends string> extends ButtonProps<V> {
  multiple?: false;
  value: V | undefined;
  onChange(value: V): void;
}

export interface MultiPickerProps<V extends string> extends ButtonProps<V> {
  multiple: true;
  value: readonly V[];
  /** Each change, while the list is open. */
  onChange(values: V[]): void;
}

export type PickerProps<V extends string> = SinglePickerProps<V> | MultiPickerProps<V>;

/** What the button of a multiple choice says: nothing chosen, the one
 * chosen, all, or how many. */
export function selectionSummary(items: readonly PickerItem[], values: readonly string[], noneLabel?: string): string {
  if (!values.length) return noneLabel ?? t('picker.none');
  if (values.length === 1) return items.find((i) => i.value === values[0])?.label ?? values[0];
  const enabled = items.filter((i) => !i.disabled);
  if (enabled.length > 1 && enabled.every((i) => values.includes(i.value))) return t('picker.all');
  return t('picker.selected', { count: values.length });
}

/** A button showing the current value(s) that opens the list below it. */
export function Picker<V extends string>(props: PickerProps<V>) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const values: readonly V[] = props.multiple ? props.value : props.value === undefined ? [] : [props.value];
  const current = !props.multiple && props.value !== undefined ? props.items.find((i) => i.value === props.value) : undefined;
  const text = props.multiple
    ? selectionSummary(props.items, values, props.noneLabel)
    : (current?.label ?? props.value ?? props.noneLabel ?? t('picker.none'));
  const close = () => setOpen(false);
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`picker-button ${props.className ?? ''}`}
        disabled={props.disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={props['aria-label']}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {current?.icon && <span className="picker-icon">{current.icon}</span>}
        <span className={`ellipsis ${values.length ? '' : 'muted'}`}>{text}</span>
        <ChevronDown className="picker-chevron" />
      </button>
      {open && button.current && (
        <PickerList<V>
          {...props}
          anchor={button.current}
          owner={button}
          multiple={!!props.multiple}
          selected={values}
          onChoose={(v) => {
            close();
            if (!props.multiple && v !== props.value) props.onChange(v);
          }}
          onSelect={(v) => props.multiple && props.onChange(v)}
          onCreate={(q) => {
            if (!props.multiple) close();
            props.onCreate?.(q);
          }}
          onDone={close}
          onCancel={close}
        />
      )}
    </>
  );
}

// ---- the imperative form ----

let openPick: (() => void) | undefined;

/** Mounts a list in a root of its own until it settles; a list opened
 * while another is open cancels that one. */
function mount<R>(render: (settle: (r: R) => void) => ReactNode, cancelled: R): Promise<R> {
  openPick?.();
  return new Promise<R>((resolve) => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    let done = false;
    const settle = (r: R) => {
      if (done) return;
      done = true;
      if (openPick === cancel) openPick = undefined;
      resolve(r);
      queueMicrotask(() => {
        root.unmount();
        host.remove();
      });
    };
    const cancel = () => settle(cancelled);
    openPick = cancel;
    root.render(render(settle));
  });
}

export interface PickOptions<V extends string> extends PickerOptions<V> {
  /** The current value: marked, and the first row without a query. */
  value?: V;
}

/** Opens a list at anchor and resolves with the item chosen, undefined
 * when dismissed; with create, { create: query } for the create row. */
export function pick<V extends string>(
  anchor: PickAnchor,
  options: PickOptions<V> & { create(query: string): string | undefined },
): Promise<V | { create: string } | undefined>;
export function pick<V extends string>(anchor: PickAnchor, options: PickOptions<V>): Promise<V | undefined>;
export function pick<V extends string>(anchor: PickAnchor, options: PickOptions<V>): Promise<V | { create: string } | undefined> {
  return mount<V | { create: string } | undefined>(
    (settle) => (
      <PickerList<V>
        {...options}
        anchor={anchor}
        multiple={false}
        selected={options.value === undefined ? [] : [options.value]}
        onChoose={settle}
        onSelect={() => {}}
        onCreate={(query) => settle({ create: query })}
        onDone={() => {}}
        onCancel={() => settle(undefined)}
      />
    ),
    undefined,
  );
}

export interface PickManyOptions<V extends string> extends Omit<PickerOptions<V>, 'create'> {
  /** Checked when the list opens. */
  value?: readonly V[];
}

/** Opens a list of check boxes at anchor and resolves with the values
 * checked when accepted (Enter, Done), undefined when dismissed. */
export function pickMany<V extends string>(anchor: PickAnchor, options: PickManyOptions<V>): Promise<V[] | undefined> {
  return mount<V[] | undefined>((settle) => <ManyList anchor={anchor} options={options} settle={settle} />, undefined);
}

function ManyList<V extends string>({
  anchor,
  options,
  settle,
}: {
  anchor: PickAnchor;
  options: PickManyOptions<V>;
  settle(r: V[] | undefined): void;
}) {
  const [values, setValues] = useState<V[]>(() => [...(options.value ?? [])]);
  return (
    <PickerList<V>
      {...options}
      anchor={anchor}
      multiple
      selected={values}
      onChoose={() => {}}
      onSelect={setValues}
      onCreate={() => {}}
      onDone={() => settle(values)}
      onCancel={() => settle(undefined)}
    />
  );
}
