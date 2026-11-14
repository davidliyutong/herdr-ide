// The find bar over a pane's top right corner (docs/features/20-find-in-panes.md):
// the query, which match is current, buttons for the older and newer
// matches, and closing. herdr searches (surface/find.ts); Enter goes to the
// older match (up, the way output was written), Shift+Enter to the newer
// one, Escape closes and gives the pane its keys back.

import { useEffect, useRef } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { t } from '../i18n';
import { closeFind, findStep, isFindKey, setFindQuery, useFind } from '../surface/find';
import { getTerm } from '../terminal/registry';

interface Props {
  m: string;
  /** Position over the surface, in CSS pixels: the pane's top right corner. */
  top: number;
  right: number;
  maxWidth: number;
}

/** What the bar says about the matches. */
export function findCount(st: { query: string; total: number; index?: number; status: string }): string {
  if (st.status === 'busy') return t('find.busy');
  if (st.status === 'failed') return t('find.failed');
  if (!st.query) return '';
  if (st.total === 0) return st.status === 'searching' ? '…' : t('find.none');
  if (st.index === undefined) return String(st.total);
  return t('find.count', { n: st.index + 1, total: st.total });
}

export function FindBar({ m, top, right, maxWidth }: Props) {
  const st = useFind();
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus({ preventScroll: true });
    input.current?.select();
  }, [st.focusSeq]);

  const close = () => {
    const pane = st.pane;
    closeFind();
    if (pane) getTerm(m, pane).focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // The keys are the bar's: no prefix bindings, nothing to the pane.
    e.stopPropagation();
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      findStep(!e.shiftKey);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (isFindKey(e.nativeEvent)) {
      e.preventDefault();
      input.current?.select();
    }
  };

  const count = findCount(st);
  const none = !!st.query && st.status === 'idle' && st.total === 0;
  return (
    <div className="find-bar" role="search" aria-label={t('find.label')} style={{ top, left: right, maxWidth }}>
      <input
        ref={input}
        className={`find-input ${none ? 'none' : ''}`}
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
      <span className={`find-count small ${st.status === 'busy' || st.status === 'failed' ? 'error' : 'muted'}`} aria-live="polite">
        {count}
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
