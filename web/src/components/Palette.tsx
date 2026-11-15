import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { actions, attentionList } from '../actions';
import { commandEnabled, commandLabel, keyHint, runCommand } from '../keymap';
import { useKeys } from '../keybindings';
import { locales, t, type MessageKey } from '../i18n';
import { usePrefs } from '../prefs';
import { agentOf, terminalTitle } from '../lib/machine';
import { useTerms } from '../state/terms';
import { StatusDot } from './StatusDot';
import { useGui } from '../gui/state';
import { enableGui } from '../gui/enable';

interface Item {
  id: string;
  label: string;
  hint?: string;
  icon?: React.ReactNode;
  run(): void;
}

const wordStart = (s: string, i: number) => i === 0 || /[\s·:/(（.-]/.test(s[i - 1]);

/** How well an item matches a query: 3 when a word starts with it, 2 when
 * it holds it, 1 when its letters are the starts of words or follow each
 * other there ("fpl" for "Focus Pane Left", "spri" for "Split Right"), 0
 * otherwise. */
export function matchScore(q: string, s: string): number {
  q = q.toLowerCase().trim();
  s = s.toLowerCase();
  const at = s.indexOf(q);
  if (at >= 0 && wordStart(s, at)) return 3;
  if (at > 0) return 2;
  let j = -1;
  for (const ch of q) {
    let k = j + 1;
    while (k < s.length && !(s[k] === ch && (k === j + 1 || wordStart(s, k)))) k++;
    if (k >= s.length) return 0;
    j = k;
  }
  return 1;
}

export function Palette() {
  const mode = useStore((s) => s.palette);
  const setPalette = useStore((s) => s.setPalette);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setQ('');
    setSel(0);
    if (mode) setTimeout(() => inputRef.current?.focus(), 0);
  }, [mode]);

  const items = useMemo<Item[]>(() => {
    if (!mode) return [];
    const s = useStore.getState();
    const ws: Item[] = [];
    const tm = useTerms.getState().machines;
    for (const m of s.order) {
      const st = s.machines[m];
      for (const w of tm[m]?.layout?.workspaces ?? []) {
        ws.push({
          id: `ws:${m}:${w.id}`,
          label: w.name || t('workspace.default'),
          hint: st?.label,
          run: () => actions.selectWorkspace(m, w.id),
        });
      }
    }
    const agents: Item[] = attentionList().map(({ m, terminal, record, status }) => ({
      id: `agent:${m}:${terminal}`,
      label: `${agentOf(record) ?? terminalTitle(record, terminal)} · ${terminalTitle(record, terminal)}`,
      hint: s.machines[m]?.label,
      icon: <StatusDot status={status} />,
      run: () => actions.focusTerminal(m, terminal),
    }));
    // Commands that open the palette, the tabs by number and commands that
    // cannot run now are left out.
    const hidden = /^(app\.commandPalette|workspace\.switch|tab\.select\d)$/;
    const cmds: Item[] = useKeys
      .getState()
      .commands.filter((c) => !hidden.test(c.id) && commandEnabled(c.id))
      .map((c) => ({ id: `cmd:${c.id}`, label: commandLabel(c.id), hint: keyHint(c.id) || undefined, run: () => runCommand(c.id) }));
    const kinds = ['claude', 'codex', 'gemini', 'opencode', 'kimi', 'grok', 'cursor', 'copilot', 'qwen', 'amp'];
    for (const k of kinds) {
      cmds.push({ id: `start:${k}`, label: t('action.startAgent', { kind: k }), run: () => void actions.startAgent(k) });
    }
    for (const l of locales) {
      cmds.push({
        id: `locale:${l.id}`,
        label: t('action.language', { lang: l.label }),
        run: () => usePrefs.getState().setPref('locale', l.id),
      });
    }
    for (const th of ['system', 'dark', 'light'] as const) {
      cmds.push({
        id: `theme:${th}`,
        label: t('action.theme', { theme: t(`settings.appearance.theme.${th}` as MessageKey) }),
        run: () => usePrefs.getState().setPref('theme', th),
      });
    }
    const f = actions.focusedContext();
    const focused = f?.terminal;
    if (f && focused && useGui.getState().machines[f.m]?.phase === 'ready') {
      cmds.push({ id: 'gui:pane', label: t('action.enableGuiPane'), run: () => void enableGui(f.m, [focused]) });
    }
    for (const st of Object.values(useGui.getState().machines)) {
      if (st.phase !== 'ready') continue;
      cmds.push({
        id: `gui:${st.m}`,
        label: t('action.enableGuiMachine', { m: s.machines[st.m]?.label ?? st.m }),
        run: () => void enableGui(st.m),
      });
    }
    if (mode === 'workspaces') return [...ws, ...agents];
    return [...cmds, ...ws, ...agents];
  }, [mode]);

  const filtered = q
    ? items
        .map((i) => ({ i, score: matchScore(q, i.label + ' · ' + (i.hint ?? '')) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.i)
    : items;
  if (!mode) return null;

  const close = () => setPalette(undefined);
  const run = (i?: Item) => {
    close();
    i?.run();
  };

  return (
    <div className="palette-backdrop" onMouseDown={close}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={q}
          placeholder={t(mode === 'workspaces' ? 'palette.placeholderWorkspaces' : 'palette.placeholder')}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close();
            else if (e.key === 'ArrowDown') setSel((v) => Math.min(v + 1, filtered.length - 1));
            else if (e.key === 'ArrowUp') setSel((v) => Math.max(v - 1, 0));
            else if (e.key === 'Enter') run(filtered[sel]);
            else return;
            e.preventDefault();
          }}
        />
        <div className="palette-list">
          {filtered.slice(0, 200).map((i, idx) => (
            <div key={i.id} className={`palette-item ${idx === sel ? 'sel' : ''}`} onMouseEnter={() => setSel(idx)} onClick={() => run(i)}>
              {i.icon}
              <span className="ellipsis">{i.label}</span>
              {i.hint && <span className="muted small hint">{i.hint}</span>}
            </div>
          ))}
          {filtered.length === 0 && <div className="muted pad">{t('palette.noMatch')}</div>}
        </div>
      </div>
    </div>
  );
}
