// The control of usage.prices (Settings › AI usage › Your prices): a form
// of a row per model, with a heading over each column (the model, then
// its input, output, cache read and cache write prices in USD per million
// tokens) and an example in each empty field, in place of the text the
// setting stores ("model input cached output [cache write]" a line each,
// internal/usage ParsePrices). A row is saved when it is complete and
// valid (on Enter or when the focus leaves it); a row that is not says
// why below it and is not saved. Cache read left empty costs the input
// price (no discount); cache write left empty costs the input price, as
// the built-in table's entries without one. The models the spend found
// without a price are offered as rows to add.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { t, type MessageKey } from '../../i18n';
import type { SettingControlProps } from '../api';
import { useUsage } from './state';

/** At most this many prices (internal/usage MaxOwnPrices). */
export const MAX_PRICES = 50;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}$/;

export interface PriceRow {
  model: string;
  input: string;
  output: string;
  cached: string;
  cacheWrite: string;
}

const EMPTY: PriceRow = { model: '', input: '', output: '', cached: '', cacheWrite: '' };

/** The rows of the setting's lines; a line that is none is kept as its
 * model so that it shows. */
export function parsePrices(lines: readonly string[]): PriceRow[] {
  return lines
    .map((l) => l.trim().split(/\s+/))
    .filter((f) => f[0])
    .map(([model, input = '', cached = '', output = '', cacheWrite = '']) => ({ model, input, output, cached, cacheWrite }));
}

const isEmpty = (r: PriceRow) => !r.model.trim() && !r.input.trim() && !r.output.trim() && !r.cached.trim() && !r.cacheWrite.trim();

const price = (v: string): boolean => {
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(v.trim())) return false;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 10000;
};

/** What is wrong with a row, given the models of the rows before it;
 * undefined when it can be saved. */
export function rowProblem(r: PriceRow, before: readonly PriceRow[]): MessageKey | undefined {
  const model = r.model.trim();
  if (!model) return 'usage.prices.error.model';
  if (!MODEL.test(model)) return 'usage.prices.error.modelChars';
  if (before.some((b) => b.model.trim() === model)) return 'usage.prices.error.twice';
  if (!r.input.trim() || !r.output.trim()) return 'usage.prices.error.required';
  for (const v of [r.input, r.output, r.cached, r.cacheWrite]) if (v.trim() && !price(v)) return 'usage.prices.error.number';
  return undefined;
}

/** The setting's lines of rows that can all be saved (empty ones left
 * out); undefined while one cannot. */
export function serializePrices(rows: readonly PriceRow[]): string[] | undefined {
  const kept = rows.filter((r) => !isEmpty(r));
  if (kept.length > MAX_PRICES) return undefined;
  const out: string[] = [];
  for (let i = 0; i < kept.length; i++) {
    const r = kept[i];
    if (rowProblem(r, kept.slice(0, i))) return undefined;
    const input = r.input.trim();
    // Cache read left empty: no discount.
    const fields = [r.model.trim(), input, r.cached.trim() || input, r.output.trim()];
    if (r.cacheWrite.trim()) fields.push(r.cacheWrite.trim());
    out.push(fields.join(' '));
  }
  return out;
}

const COLUMNS: { key: keyof PriceRow; label: MessageKey; placeholder: MessageKey }[] = [
  { key: 'model', label: 'usage.prices.model', placeholder: 'usage.prices.model.placeholder' },
  { key: 'input', label: 'usage.prices.input', placeholder: 'usage.prices.input.placeholder' },
  { key: 'output', label: 'usage.prices.output', placeholder: 'usage.prices.output.placeholder' },
  { key: 'cached', label: 'usage.prices.cached', placeholder: 'usage.prices.cached.placeholder' },
  { key: 'cacheWrite', label: 'usage.prices.cacheWrite', placeholder: 'usage.prices.cacheWrite.placeholder' },
];

export function PricesEditor({ value, disabled, onChange }: SettingControlProps) {
  const lines = useMemo(() => (Array.isArray(value) ? value.map(String) : []), [value]);
  const [rows, setRows] = useState<PriceRow[]>(() => parsePrices(lines));
  const [tried, setTried] = useState(false);
  const formRef = useRef<HTMLDivElement>(null);
  // The field of the last row to focus once a row was added.
  const focusLast = useRef<keyof PriceRow | undefined>(undefined);
  // The setting changed (saved here, reset, or from another page).
  const key = lines.join('\n');
  useEffect(() => {
    setRows(parsePrices(lines));
    setTried(false);
  }, [key]);
  useEffect(() => {
    const column = focusLast.current;
    if (!column) return;
    focusLast.current = undefined;
    const rowsShown = formRef.current?.querySelectorAll('.prices-row');
    rowsShown?.[rowsShown.length - 1]?.querySelector<HTMLInputElement>(`input[data-column="${column}"]`)?.focus();
  });

  const save = (next: PriceRow[]) => {
    const out = serializePrices(next);
    setTried(true);
    if (out && out.join('\n') !== key) onChange(out);
  };
  const set = (i: number, k: keyof PriceRow, v: string) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const add = (model = '') => {
    if (rows.length >= MAX_PRICES) return;
    focusLast.current = model ? 'input' : 'model';
    setTried(false);
    setRows((rs) => [...rs, { ...EMPTY, model }]);
  };
  const remove = (i: number) => {
    const next = rows.filter((_, j) => j !== i);
    setRows(next);
    save(next);
  };

  // The models the spend found without a price, not in a row yet.
  const cost = useUsage((s) => s.cost);
  const unpriced = useMemo(() => {
    const have = new Set(rows.map((r) => r.model.trim()));
    const all = new Set(Object.values(cost?.machines ?? {}).flatMap((m) => m.unpriced ?? []));
    return [...all].filter((m) => MODEL.test(m) && !have.has(m)).sort();
  }, [cost, rows]);

  return (
    <div className="prices-editor" ref={formRef}>
      {rows.length > 0 && (
        <div className="prices-table" role="table" aria-label={t('usage.prices.table')}>
          <div className="prices-head" role="row">
            {COLUMNS.map((c) => (
              <span key={c.key} role="columnheader" className="prices-col-title" data-column={c.key}>
                {t(c.label)}
              </span>
            ))}
            <span aria-hidden />
          </div>
          {rows.map((r, i) => {
            const problem = tried && !isEmpty(r) ? rowProblem(r, rows.slice(0, i)) : undefined;
            return (
              <div key={i} className="prices-row-wrap">
                <div
                  className={`prices-row${problem ? ' invalid' : ''}`}
                  role="row"
                  onBlur={(e) => {
                    // Saved once the focus leaves the row.
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) save(rows);
                  }}
                >
                  {COLUMNS.map((c) => (
                    <input
                      key={c.key}
                      role="cell"
                      className="settings-input"
                      data-column={c.key}
                      value={r[c.key]}
                      disabled={disabled}
                      spellCheck={false}
                      inputMode={c.key === 'model' ? undefined : 'decimal'}
                      placeholder={t(c.placeholder)}
                      aria-label={t('usage.prices.cell', { column: t(c.label), row: i + 1 })}
                      aria-invalid={problem ? true : undefined}
                      onChange={(e) => set(i, c.key, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') save(rows);
                        if (e.key === 'Escape') {
                          e.stopPropagation();
                          e.nativeEvent.stopImmediatePropagation();
                          setRows(parsePrices(lines));
                          setTried(false);
                        }
                      }}
                    />
                  ))}
                  {!disabled && (
                    <button
                      type="button"
                      className="icon sm"
                      title={t('usage.prices.remove', { model: r.model.trim() || t('usage.prices.thisRow') })}
                      aria-label={t('usage.prices.remove', { model: r.model.trim() || t('usage.prices.thisRow') })}
                      onClick={() => remove(i)}
                    >
                      <X />
                    </button>
                  )}
                </div>
                {problem && <div className="error small prices-problem">{t(problem)}</div>}
              </div>
            );
          })}
        </div>
      )}
      {!disabled && (
        <div className="prices-actions">
          <button type="button" className="sm" disabled={rows.length >= MAX_PRICES} onClick={() => add()}>
            <Plus aria-hidden /> {t('usage.prices.add')}
          </button>
          {unpriced.length > 0 && (
            <span className="prices-unpriced small">
              <span className="muted">{t('usage.prices.unpriced')}</span>
              {unpriced.slice(0, 12).map((m) => (
                <button
                  key={m}
                  type="button"
                  className="list-chip prices-suggest"
                  title={t('usage.prices.addModel', { model: m })}
                  aria-label={t('usage.prices.addModel', { model: m })}
                  disabled={rows.length >= MAX_PRICES}
                  onClick={() => add(m)}
                >
                  <Plus aria-hidden />
                  <span className="ellipsis">{m}</span>
                </button>
              ))}
            </span>
          )}
        </div>
      )}
      <div className="muted small prices-hint">{t('usage.prices.hint')}</div>
    </div>
  );
}
