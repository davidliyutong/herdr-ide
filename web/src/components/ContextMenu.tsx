import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, Search } from 'lucide-react';
import { closeMenu, FILTER_FIELD_AT, filterMenu, isItem, stepIndex, useMenu, type MenuEntry, type MenuState } from '../contextMenu';
import { t } from '../i18n';
import { Highlight } from './Highlight';

export function ContextMenu() {
  const menu = useMenu((s) => s.menu);
  return menu ? <MenuView key={menu.seq} menu={menu} /> : null;
}

function MenuView({ menu }: { menu: MenuState }) {
  const { x, y, entries } = menu;
  const ref = useRef<HTMLDivElement>(null);
  return <MenuList ref={ref} x={x} y={y} entries={entries} root={ref} />;
}

/** Shows an element's whole text as its tooltip while it is cut with an
 * ellipsis (a long workspace or machine name). */
export function titleIfCut(e: React.MouseEvent<HTMLElement>) {
  const el = e.currentTarget.querySelector<HTMLElement>('.ellipsis') ?? e.currentTarget;
  if (el.scrollWidth > el.clientWidth) e.currentTarget.title = el.textContent ?? '';
  else e.currentTarget.removeAttribute('title');
}

/** Rows a page key moves. */
const PAGE = 8;

/** A list of items at x, y (kept inside the window, scrolling when taller
 * than it); an item with a submenu opens it beside itself. Keys: arrows,
 * PgUp, PgDn, Home, End, Enter and Space, → opens a submenu and ← or Escape
 * closes it. Typing filters the items (a field shows what is typed; menus
 * of many items show it from the start), Backspace widens the filter and
 * Escape clears it before it closes the menu. */
function MenuList({
  ref,
  x,
  y,
  entries,
  root,
  flipX,
  onBack,
}: {
  ref: React.RefObject<HTMLDivElement | null>;
  x: number;
  y: number;
  entries: MenuEntry[];
  root: React.RefObject<HTMLDivElement | null>;
  /** Where a submenu goes when it does not fit to the right: the left edge
   * of the item that opened it. */
  flipX?: number;
  onBack?(): void;
}) {
  const [query, setQuery] = useState('');
  const shown = useMemo(() => filterMenu(entries, query), [entries, query]);
  const list = useMemo(() => shown.map((s) => s.entry), [shown]);
  // The field, once shown, stays: clearing the filter keeps it.
  const [typed, setTyped] = useState(false);
  const filtering = typed || entries.filter(isItem).length >= FILTER_FIELD_AT;
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState<{ left: number; top: number; width?: number }>({ left: x, top: y });
  const [sub, setSub] = useState<{ index: number; x: number; y: number; flipX: number }>();
  const subRef = useRef<HTMLDivElement>(null);
  const items = useRef<(HTMLDivElement | null)[]>([]);
  const field = useRef<HTMLInputElement>(null);
  // The keyboard's item is scrolled into view; the pointer's is not.
  const reveal = useRef(false);

  // Keep the menu inside the window, then take the keyboard.
  useLayoutEffect(() => {
    const el = ref.current!;
    const r = el.getBoundingClientRect();
    const left = x + r.width > window.innerWidth - 4 && flipX !== undefined ? flipX - r.width : x;
    // The width found first stays while the filter narrows the items.
    setPos({
      left: Math.max(4, Math.min(left, window.innerWidth - r.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)),
      width: r.width || undefined,
    });
    (field.current ?? el).focus({ preventScroll: true });
  }, [x, y]);

  // The field appears with the first key typed and takes the keyboard.
  useEffect(() => {
    const f = field.current;
    if (!filtering || !f || document.activeElement !== ref.current) return;
    f.focus({ preventScroll: true });
    f.setSelectionRange(f.value.length, f.value.length);
  }, [filtering]);

  useLayoutEffect(() => {
    if (!reveal.current || active < 0) return;
    reveal.current = false;
    items.current[active]?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  const move = (i: number) => {
    reveal.current = true;
    setActive(i);
  };

  const filter = (q: string) => {
    setQuery(q);
    if (q) setTyped(true);
    setSub(undefined);
    // The first match has the keyboard.
    move(
      q
        ? stepIndex(
            filterMenu(entries, q).map((s) => s.entry),
            -1,
            1,
          )
        : -1,
    );
  };

  const openSub = (i: number) => {
    const e = list[i];
    const el = items.current[i];
    if (!isItem(e) || !e.submenu || e.disabled || !el) return;
    const r = el.getBoundingClientRect();
    setSub({ index: i, x: r.right - 2, y: r.top - 5, flipX: r.left + 2 });
  };

  useEffect(() => {
    if (root !== ref) return;
    const inMenu = (t: EventTarget | null) => t instanceof Element && !!t.closest('.context-menu');
    const outside = (e: PointerEvent) => !inMenu(e.target) && closeMenu(false);
    const close = () => closeMenu(false);
    // Scrolling a list would leave the menu away from its row; scroll events
    // do not bubble, so they are caught on the way down. A menu's own
    // scrolling keeps it.
    const scrolled = (e: Event) => !inMenu(e.target) && closeMenu(false);
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('scroll', scrolled, true);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('scroll', scrolled, true);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
    };
  }, []);

  const run = (i: number) => {
    const e = list[i];
    if (!isItem(e) || e.disabled) return;
    if (e.submenu) return openSub(i);
    // Focus goes back first, so an item that moves it (rename, split) wins.
    closeMenu(true);
    e.run?.();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Keys stay in the menu: no prefix bindings while it is open.
    e.stopPropagation();
    const inField = e.target === field.current;
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
    switch (e.key) {
      case 'ArrowRight':
        // In the field the caret moves unless the item opens a submenu.
        if (active < 0 || !(isItem(list[active]) && list[active].submenu)) {
          if (inField) return;
          break;
        }
        openSub(active);
        break;
      case 'ArrowLeft':
        if (!onBack) {
          if (inField) return;
          break;
        }
        onBack();
        break;
      case 'ArrowDown':
        move(stepIndex(list, active, 1));
        break;
      case 'ArrowUp':
        move(stepIndex(list, active < 0 ? 0 : active, -1));
        break;
      case 'PageDown':
        move(pageFrom(list, active, PAGE));
        break;
      case 'PageUp':
        move(pageFrom(list, active, -PAGE));
        break;
      case 'Home':
        move(stepIndex(list, -1, 1));
        break;
      case 'End':
        move(stepIndex(list, list.length, -1));
        break;
      case 'Enter':
        if (active >= 0) run(active);
        break;
      case ' ':
        // While filtering, a space is typed.
        if (query) return inField ? undefined : filter(query + ' ');
        if (active >= 0) run(active);
        break;
      case 'Escape':
        if (query) filter('');
        else if (onBack) onBack();
        else closeMenu(true);
        break;
      case 'Tab':
        closeMenu(true);
        break;
      case 'Backspace':
        if (inField) return;
        if (query) filter(query.slice(0, -1));
        break;
      default:
        // A character typed on the menu starts the filter; in the field it types.
        if (inField || !plain || e.key.length !== 1) return;
        filter(query + e.key);
    }
    e.preventDefault();
  };

  const subEntry = sub ? list[sub.index] : undefined;
  return (
    <>
      <div
        ref={ref}
        className="context-menu"
        role="menu"
        tabIndex={-1}
        style={{ left: pos.left, top: pos.top, minWidth: pos.width }}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => e.preventDefault()}
        onMouseDown={(e) => e.target !== field.current && e.preventDefault()}
      >
        {filtering && (
          <label className="context-filter">
            <Search />
            <input
              ref={field}
              value={query}
              placeholder={t('menu.filter')}
              aria-label={t('menu.filter')}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => filter(e.target.value)}
            />
          </label>
        )}
        <div className="context-list">
          {shown.map(({ entry: e, index, ranges }, i) =>
            isItem(e) ? (
              <div
                key={index}
                ref={(el) => {
                  items.current[i] = el;
                }}
                role="menuitem"
                aria-disabled={e.disabled || undefined}
                aria-haspopup={e.submenu ? 'menu' : undefined}
                aria-expanded={e.submenu ? sub?.index === i : undefined}
                className={`context-item ${i === active ? 'sel' : ''} ${e.danger ? 'danger' : ''} ${e.disabled ? 'disabled' : ''}`}
                onMouseEnter={(ev) => {
                  titleIfCut(ev);
                  setActive(e.disabled ? -1 : i);
                  if (e.submenu) openSub(i);
                  else setSub(undefined);
                }}
                onClick={() => run(i)}
              >
                <span className="context-icon">{e.icon}</span>
                <span className="ellipsis">
                  <Highlight text={e.label} ranges={ranges} />
                </span>
                {e.hint && <span className="hint muted small">{e.hint}</span>}
                {e.submenu && (
                  <span className="hint context-chevron">
                    <ChevronRight />
                  </span>
                )}
              </div>
            ) : (
              <div key={index} role="separator" className="context-sep" />
            ),
          )}
          {query && !shown.length && <div className="context-empty muted">{t('menu.noMatch')}</div>}
        </div>
      </div>
      {sub && isItem(subEntry) && subEntry.submenu && (
        <MenuList
          key={`${query}\n${sub.index}`}
          ref={subRef}
          x={sub.x}
          y={sub.y}
          flipX={sub.flipX}
          entries={subEntry.submenu}
          root={root}
          onBack={() => {
            setSub(undefined);
            (field.current ?? ref.current)?.focus({ preventScroll: true });
          }}
        />
      )}
    </>
  );
}

/** The enabled item about delta rows from cur, kept within the list: the
 * nearest enabled one at or before the row reached (after it going up). */
function pageFrom(list: readonly MenuEntry[], cur: number, delta: number): number {
  const enabled = list.map((e, i) => (isItem(e) && !e.disabled ? i : -1)).filter((i) => i >= 0);
  if (!enabled.length) return -1;
  if (cur < 0) return delta > 0 ? enabled[0] : enabled[enabled.length - 1];
  const target = Math.max(0, Math.min(list.length - 1, cur + delta));
  const at = delta > 0 ? [...enabled].reverse().find((i) => i <= target) : enabled.find((i) => i >= target);
  return at ?? cur;
}
