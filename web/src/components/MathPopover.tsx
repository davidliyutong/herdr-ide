// The formula under the pointer, rendered by KaTeX, below it (above when
// there is no room below), with a button that copies its LaTeX source. The
// controller shows and hides it (surface/controller.ts, updateMath); the
// pointer may move onto it.

import { useLayoutEffect, useRef, useState } from 'react';
import { Copy } from 'lucide-react';
import { t } from '../i18n';
import { useStore } from '../state/store';
import type { ShownMath } from '../surface/controller';

/** Space between the formula's rows and the popover, and the popover and
 * the edges of the panes. */
const GAP = 6;
const EDGE = 4;

interface Props {
  math: ShownMath;
  /** CSS pixels per cell. */
  cw: number;
  ch: number;
}

export function MathPopover({ math, cw, ch }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>();
  const top = Math.min(...math.cells.map((c) => c.y)) * ch;
  const bottom = (Math.max(...math.cells.map((c) => c.y)) + 1) * ch;
  const left = Math.min(...math.cells.map((c) => c.from)) * cw;

  useLayoutEffect(() => {
    const el = ref.current;
    const host = el?.parentElement;
    if (!el || !host) return;
    const place = () => {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const H = host.clientHeight;
      const below = bottom + GAP;
      const above = top - GAP - h;
      const y = below + h <= H - EDGE || above < EDGE ? below : above;
      setPos({ left: Math.max(EDGE, Math.min(left, host.clientWidth - w - EDGE)), top: Math.max(EDGE, Math.min(y, H - h - EDGE)) });
    };
    place();
    // KaTeX's fonts arrive after the first layout and change its size.
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [math, top, bottom, left]);

  const copy = () => {
    void navigator.clipboard
      ?.writeText(math.tex)
      .then(() => useStore.getState().toast(t('math.copied')))
      .catch(() => {});
  };

  return (
    <div
      ref={ref}
      className={`math-popover ${math.display ? 'display' : ''}`}
      aria-label={t('math.title')}
      style={pos ?? { left: 0, top: 0, visibility: 'hidden' }}
    >
      {/* KaTeX's own markup; the formula is read with trust off (terminal/mathRender.ts). */}
      <div className="math-render" dangerouslySetInnerHTML={{ __html: math.html }} />
      <button className="icon math-copy" title={t('math.copy')} aria-label={t('math.copy')} onClick={copy}>
        <Copy />
      </button>
    </div>
  );
}
