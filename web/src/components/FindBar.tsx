// The find bar over a pane's top right corner (docs/features/20-find-in-panes.md):
// the query with its options (match case, whole word, regular expression),
// which match is current, buttons for the older and newer matches, and
// closing. The machine's agent searches (surface/find.ts); Enter goes to
// the older match (up, the way output was written), Shift+Enter to the
// newer one, Escape closes and gives the pane its keys back.

import { useEffect, useRef } from 'react';
import { CaseSensitive, ChevronDown, ChevronUp, Regex, WholeWord, X } from 'lucide-react';
import { t } from '../i18n';
import {
  closeFind,
  findOptionKey,
  findOptionKeyLabel,
  findStep,
  isFindKey,
  setFindQuery,
  toggleFindOption,
  useFind,
  type FindOption,
} from '../surface/find';
import { getTerm } from '../terminal/registry';

interface Props {
  m: string;
  /** Position over the surface, in CSS pixels: the pane's top right corner. */
  top: number;
  right: number;
  maxWidth: number;
}

/** What the bar says about the matches. */
export function findCount(st: { query: string; total: number; capped?: boolean; index?: number; status: string }): string {
  if (st.status === 'busy') return t('find.busy');
  if (st.status === 'failed') return t('find.failed');
  if (st.status === 'invalid') return t('find.invalid');
  if (!st.query) return '';
  if (st.total === 0) return st.status === 'searching' ? '…' : t('find.none');
  const total = st.capped ? t('find.more', { total: st.total }) : String(st.total);
  if (st.index === undefined) return total;
  return t('find.count', { n: st.index + 1, total });
}

const optionIcons: Record<FindOption, typeof CaseSensitive> = { matchCase: CaseSensitive, wholeWord: WholeWord, regex: Regex };

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
    const option = findOptionKey(e.nativeEvent);
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      findStep(!e.shiftKey);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (isFindKey(e.nativeEvent)) {
      e.preventDefault();
      input.current?.select();
    } else if (option) {
      // Not the character Option types on macOS.
      e.preventDefault();
      toggleFindOption(option);
    }
  };

  const count = findCount(st);
  const none = !!st.query && st.status === 'idle' && st.total === 0;
  const invalid = st.status === 'invalid';
  const failed = st.status === 'busy' || st.status === 'failed' || invalid;
  return (
    <div className="find-bar" role="search" aria-label={t('find.label')} style={{ top, left: right, maxWidth }}>
      <div className={`find-field ${none || invalid ? 'none' : ''}`}>
        <input
          ref={input}
          className="find-input"
          value={st.query}
          placeholder={t('find.placeholder')}
          aria-label={t('find.placeholder')}
          aria-invalid={invalid}
          title={invalid ? st.error : undefined}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          onChange={(e) => setFindQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {(Object.keys(optionIcons) as FindOption[]).map((o) => {
          const Icon = optionIcons[o];
          const label = `${t(`find.option.${o}`)} (${findOptionKeyLabel(o)})`;
          return (
            <button
              key={o}
              className={`icon find-option ${st.options[o] ? 'on' : ''}`}
              title={label}
              aria-label={label}
              aria-pressed={st.options[o]}
              // Keep the focus (and the caret) in the input.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => toggleFindOption(o)}
            >
              <Icon />
            </button>
          );
        })}
      </div>
      <span className={`find-count small ${failed ? 'error' : 'muted'}`} aria-live="polite" title={invalid ? st.error : undefined}>
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
