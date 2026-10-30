import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { closeMenu, isItem, stepIndex, useMenu, type MenuState } from '../contextMenu';

export function ContextMenu() {
  const menu = useMenu((s) => s.menu);
  return menu ? <MenuView key={menu.seq} menu={menu} /> : null;
}

function MenuView({ menu }: { menu: MenuState }) {
  const { x, y, entries } = menu;
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState({ left: x, top: y });

  // Keep the menu inside the window, then take the keyboard.
  useLayoutEffect(() => {
    const el = ref.current!;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)),
    });
    el.focus({ preventScroll: true });
  }, [x, y]);

  useEffect(() => {
    const outside = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && closeMenu(false);
    const close = () => closeMenu(false);
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
    };
  }, []);

  const run = (i: number) => {
    const e = entries[i];
    if (!isItem(e) || e.disabled) return;
    // Focus goes back first, so an item that moves it (rename, split) wins.
    closeMenu(true);
    e.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Keys stay in the menu: no prefix bindings while it is open.
    e.stopPropagation();
    switch (e.key) {
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
      case 'Tab':
        closeMenu(true);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  return (
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
            role="menuitem"
            aria-disabled={e.disabled || undefined}
            className={`context-item ${i === active ? 'sel' : ''} ${e.danger ? 'danger' : ''} ${e.disabled ? 'disabled' : ''}`}
            onMouseEnter={() => setActive(e.disabled ? -1 : i)}
            onClick={() => run(i)}
          >
            <span className="context-icon">{e.icon}</span>
            <span className="ellipsis">{e.label}</span>
            {e.hint && <span className="hint muted small">{e.hint}</span>}
          </div>
        ) : (
          <div key={i} role="separator" className="context-sep" />
        ),
      )}
    </div>
  );
}
