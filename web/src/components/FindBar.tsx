// The find bar over a terminal's top right corner
// (docs/features/26-web-terminals.md): the query, which match is
// current, buttons for the older and newer matches, and closing. The
// terminal's emulator searches its screen and scrollback (vt/find.ts);
// Enter goes to the older match (up, the way output was written),
// Shift+Enter to the newer one, Escape closes and gives the terminal its
// keys back.

import { useEffect, useRef } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { t } from '../i18n';
import { closeFind, findStep, setFindQuery, useFind } from '../vt/find';
import { withView } from '../state/panes';
import { isCommandKey } from '../keymap';

/** What the bar says about the matches. */
export function findCount(st: { query: string; total: number; selected?: number }): string {
  if (!st.query) return '';
  if (st.total === 0) return t('find.none');
  if (st.selected === undefined) return String(st.total);
  return t('find.count', { n: st.selected + 1, total: st.total });
}

export function FindBar({ m, terminal }: { m: string; terminal: string }) {
  const st = useFind();
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus({ preventScroll: true });
    input.current?.select();
  }, [st.focusSeq]);

  // The pane gets its keys back: what covers the terminal when something does.
  const close = () => {
    closeFind();
    withView(m, terminal, (h) => h.focus(), 0);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // The keys are the bar's: nothing reaches the terminal.
    e.stopPropagation();
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      findStep(!e.shiftKey);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (isCommandKey(e.nativeEvent, 'find.open')) {
      // The find key again selects the query.
      e.preventDefault();
      input.current?.select();
    }
  };

  const none = !!st.query && st.total === 0;
  return (
    <div className="find-bar" role="search" aria-label={t('find.label')} onMouseDown={(e) => e.stopPropagation()}>
      <div className={`find-field ${none ? 'none' : ''}`}>
        <input
          ref={input}
          className="find-input"
          value={st.query}
          placeholder={t('find.placeholder')}
          aria-label={t('find.placeholder')}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          onChange={(e) => setFindQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      <span className="find-count small muted" aria-live="polite">
        {findCount(st)}
      </span>
      <button className="icon" title={t('find.older')} aria-label={t('find.older')} disabled={!st.total} onClick={() => findStep(true)}>
        <ChevronUp />
      </button>
      <button className="icon" title={t('find.newer')} aria-label={t('find.newer')} disabled={!st.total} onClick={() => findStep(false)}>
        <ChevronDown />
      </button>
      <button className="icon" title={t('find.close')} aria-label={t('find.close')} onClick={close}>
        <X />
      </button>
    </div>
  );
}
