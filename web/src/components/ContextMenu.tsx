import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { closeMenu, isItem, stepIndex, useMenu, type MenuEntry, type MenuState } from '../contextMenu';

export function ContextMenu() {
  const menu = useMenu((s) => s.menu);
  return menu ? <MenuView key={menu.seq} menu={menu} /> : null;
}

function MenuView({ menu }: { menu: MenuState }) {
  const { x, y, entries } = menu;
  const ref = useRef<HTMLDivElement>(null);
  return <MenuList ref={ref} x={x} y={y} entries={entries} root={ref} />;
}

/** A list of items at x, y (kept inside the window); an item with a
 * submenu opens it beside itself. Keys: arrows, Home, End, Enter and Space,
 * → opens a submenu and ← or Escape closes it. */
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
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState({ left: x, top: y });
  const [sub, setSub] = useState<{ index: number; x: number; y: number; flipX: number }>();
  const subRef = useRef<HTMLDivElement>(null);
  const items = useRef<(HTMLDivElement | null)[]>([]);

  // Keep the menu inside the window, then take the keyboard.
  useLayoutEffect(() => {
    const el = ref.current!;
    const r = el.getBoundingClientRect();
    const left = x + r.width > window.innerWidth - 4 && flipX !== undefined ? flipX - r.width : x;
    setPos({
      left: Math.max(4, Math.min(left, window.innerWidth - r.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)),
    });
    el.focus({ preventScroll: true });
  }, [x, y]);

  const openSub = (i: number) => {
    const e = entries[i];
    const el = items.current[i];
    if (!isItem(e) || !e.submenu || e.disabled || !el) return;
    const r = el.getBoundingClientRect();
    setSub({ index: i, x: r.right - 2, y: r.top - 5, flipX: r.left + 2 });
  };

  useEffect(() => {
    if (root !== ref) return;
    const outside = (e: PointerEvent) => !(e.target as HTMLElement).closest?.('.context-menu') && closeMenu(false);
    const close = () => closeMenu(false);
    // Scrolling a list would leave the menu away from its row; scroll events
    // do not bubble, so they are caught on the way down.
    const scrolled = (e: Event) => !ref.current?.contains(e.target as Node) && closeMenu(false);
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
    const e = entries[i];
    if (!isItem(e) || e.disabled) return;
    if (e.submenu) return openSub(i);
    // Focus goes back first, so an item that moves it (rename, split) wins.
    closeMenu(true);
    e.run?.();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Keys stay in the menu: no prefix bindings while it is open.
    e.stopPropagation();
    switch (e.key) {
      case 'ArrowRight':
        if (active >= 0) openSub(active);
        break;
      case 'ArrowLeft':
        onBack?.();
        break;
      case 'ArrowDown':
        setActive(stepIndex(entries, active, 1));
        break;
      case 'ArrowUp':
        setActive(stepIndex(entries, active < 0 ? 0 : active, -1));
        break;
      case 'Home':
        setActive(stepIndex(entries, -1, 1));
        break;
      case 'End':
        setActive(stepIndex(entries, entries.length, -1));
        break;
      case 'Enter':
      case ' ':
        if (active >= 0) run(active);
        break;
      case 'Escape':
        if (onBack) onBack();
        else closeMenu(true);
        break;
      case 'Tab':
        closeMenu(true);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const subEntry = sub ? entries[sub.index] : undefined;
  return (
    <>
      <div
        ref={ref}
        className="context-menu"
        role="menu"
        tabIndex={-1}
        style={{ left: pos.left, top: pos.top }}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => e.preventDefault()}
        onMouseDown={(e) => e.preventDefault()}
      >
        {entries.map((e, i) =>
          isItem(e) ? (
            <div
              key={i}
              ref={(el) => {
                items.current[i] = el;
              }}
              role="menuitem"
              aria-disabled={e.disabled || undefined}
              aria-haspopup={e.submenu ? 'menu' : undefined}
              aria-expanded={e.submenu ? sub?.index === i : undefined}
              className={`context-item ${i === active ? 'sel' : ''} ${e.danger ? 'danger' : ''} ${e.disabled ? 'disabled' : ''}`}
              onMouseEnter={() => {
                setActive(e.disabled ? -1 : i);
                if (e.submenu) openSub(i);
                else setSub(undefined);
              }}
              onClick={() => run(i)}
            >
              <span className="context-icon">{e.icon}</span>
              <span className="ellipsis">{e.label}</span>
              {e.hint && <span className="hint muted small">{e.hint}</span>}
              {e.submenu && (
                <span className="hint context-chevron">
                  <ChevronRight />
                </span>
              )}
            </div>
          ) : (
            <div key={i} role="separator" className="context-sep" />
          ),
        )}
      </div>
      {sub && isItem(subEntry) && subEntry.submenu && (
        <MenuList
          key={sub.index}
          ref={subRef}
          x={sub.x}
          y={sub.y}
          flipX={sub.flipX}
          entries={subEntry.submenu}
          root={root}
          onBack={() => {
            setSub(undefined);
            ref.current?.focus({ preventScroll: true });
          }}
        />
      )}
    </>
  );
}
