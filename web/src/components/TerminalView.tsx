// One terminal of a machine on screen: a canvas the terminal emulator's
// renderer draws (vt/pane.ts), and what goes over it: find, a formula under
// the pointer, where dropped files go, the scrollbar, and the end of the
// program.

import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { terms, useTerms } from '../state/terms';
import * as L from '../term/layout';
import { registerPane } from '../state/panes';
import { usePrefs, getPrefs } from '../prefs';
import { appearanceOf, useThemeKind } from '../appearance';
import { handleKey } from '../keymap';
import { uploadPasted } from '../transfers';
import { droppedItems, droppedPaths, filesAreOn } from '../drop';
import { shortPath } from '../lib/machine';
import { TermPane, type ShownMath } from '../vt/pane';
import { openFind, useFind } from '../vt/find';
import { whenTermFont } from '../terminal/fonts';
import { playSound } from '../sound';
import { MathPopover } from './MathPopover';
import { FindBar } from './FindBar';
import { hasMessage, t } from '../i18n';

interface Props {
  m: string;
  terminal: string;
  /** The tab's focused terminal. */
  focused: boolean;
  /** A press in the terminal focuses it in the layout. */
  onActivate(): void;
  /** False for a terminal kept mounted while its tab is not shown
   * (keptPanes.ts): it takes its output and draws nothing. */
  shown?: boolean;
}

/** What dropping files on the terminal does. */
function dropLabel(m: string, terminal: string): string {
  if (filesAreOn(m)) return t('surface.dropHere');
  const st = useStore.getState().machines[m];
  const dir = terms.directory(m, terminal);
  const machine = st?.label ?? m;
  return dir ? t('surface.dropUploadInto', { machine, dir: shortPath(dir, st?.info?.home) }) : t('surface.dropUpload', { machine });
}

/** How a program's terminal ended, in words. */
function closedText(reason: string): string {
  const key = `term.closed.${reason}`;
  return hasMessage(key) ? t(key) : t('term.closed.other', { reason });
}

export function TerminalView({ m, terminal, focused, onActivate, shown = true }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const paneRef = useRef<TermPane>(undefined);
  const prefs = usePrefs((s) => s.prefs);
  // The "system" theme changes without the settings changing.
  const theme = useThemeKind();
  const [closed, setClosed] = useState<{ reason: string; code?: number }>();
  const [math, setMath] = useState<ShownMath>();
  const [title, setTitle] = useState('');
  const [drop, setDrop] = useState(false);
  const [flash, setFlash] = useState(false);
  const [cell, setCell] = useState({ cw: 8, ch: 16 });
  const [bar, setBar] = useState<{ total: number; offset: number; len: number }>();
  const [renderer, setRenderer] = useState<string>();
  const findHere = useFind((s) => s.m === m && s.terminal === terminal);
  /** Ends a drag along the scrollbar, if one is under way. */
  const endScrollDrag = useRef<() => void>(undefined);
  const activate = useRef(onActivate);
  activate.current = onActivate;

  useEffect(() => {
    let flashTimer: number | undefined;
    const pane = new TermPane(
      hostRef.current!,
      canvasRef.current!,
      inputRef.current!,
      {
        m,
        address: terminal,
        connection: terms.connection,
        // Attached again when the connection is back, and when the machine
        // is: its streams end while the connection to the core stays.
        onConnection: (fn) => {
          const offCore = terms.onConnection(fn);
          const offMachine = terms.onTerminals(m, () => fn(true));
          return () => {
            offCore();
            offMachine();
          };
        },
        readOnly: () => useStore.getState().readOnly,
        appKey: (ev) => handleKey(ev),
        activate: () => activate.current(),
        linkContext: () => ({ m, pane: terminal, cwd: terms.directory(m, terminal), home: useStore.getState().machines[m]?.info?.home }),
        mathHover: () => getPrefs().mathHover,
        copyOnSelect: () => getPrefs().copyOnSelect,
        scrollback: () => getPrefs().scrollback,
        onPasteFiles: (files) => uploadPasted(m, files),
        onDropFiles: (items) => droppedPaths(m, droppedItems(items), terms.directory(m, terminal)),
        onDropTarget: setDrop,
        setTitle,
        onMath: setMath,
        onFind: (text) => openFind(m, terminal, text),
        onClosed: (reason, code) => setClosed({ reason, code }),
        onBell: () => {
          const mode = getPrefs().bell;
          if (mode === 'sound') playSound('bell');
          if (mode !== 'visual') return;
          setFlash(true);
          window.clearTimeout(flashTimer);
          flashTimer = window.setTimeout(() => setFlash(false), 150);
        },
        onScroll: setBar,
        onCell: (cw, ch) => setCell({ cw, ch }),
        onRenderer: setRenderer,
        // A terminal that lost its agent with its core gets it back (restore.ts).
        onAttached: () => terms.resumeAgent(m, terminal, (text) => pane.type(text)),
      },
      appearanceOf(getPrefs()),
    );
    paneRef.current = pane;
    const off = registerPane(m, terminal, {
      focus: () => pane.focus(),
      type: (text) => pane.type(text),
      paste: (text) => pane.paste(text),
      openFind: () => pane.openFind(),
      screenText: () => pane.screenText(),
    });
    return () => {
      off();
      window.clearTimeout(flashTimer);
      endScrollDrag.current?.();
      pane.dispose();
      paneRef.current = undefined;
    };
  }, [m, terminal]);

  useEffect(() => paneRef.current?.setShown(shown), [shown, m, terminal]);

  // A terminal that lost its agent with its core gets it back (restore.ts):
  // asked for while the pane is attached here, and in onAttached otherwise.
  const resume = useTerms((s) => {
    const layout = s.machines[m]?.layout;
    const leaf = layout && L.findLeaf(layout, terminal);
    return leaf && L.isTerminalLeaf(leaf) && typeof leaf.resume === 'string' ? leaf.resume : undefined;
  });
  useEffect(() => {
    const pane = paneRef.current;
    if (resume && pane?.attached) terms.resumeAgent(m, terminal, (text) => pane.type(text));
  }, [resume, m, terminal]);

  // Appearance: colors, font and size, cursor, scrollback.
  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    const a = appearanceOf(prefs);
    pane.setAppearance(a);
    return whenTermFont(a.fontWeight, () => pane.setAppearance(appearanceOf(getPrefs())));
  }, [prefs, theme]);

  // The focused terminal takes the keyboard unless something else on the
  // page has it (a field, a dialog, VS Code).
  useEffect(() => {
    if (!focused) return;
    const a = document.activeElement;
    if (!a || a === document.body || a.closest('.term-host')) paneRef.current?.focus();
  }, [focused]);

  const thumb =
    bar && bar.total > bar.len
      ? { top: `${(bar.offset / bar.total) * 100}%`, height: `${Math.max((bar.len / bar.total) * 100, 3)}%` }
      : undefined;

  return (
    <div className={`term-host ${flash ? 'bell' : ''}`} ref={hostRef} title={title} data-renderer={renderer}>
      <canvas ref={canvasRef} className="term-canvas" />
      <textarea
        ref={inputRef}
        className="term-input"
        aria-label={t('surface.input')}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        tabIndex={0}
      />
      {thumb && (
        <div
          className="term-scrollbar"
          onMouseDown={(e) => {
            // Click or drag along the bar: the view follows the pointer.
            e.preventDefault();
            const track = e.currentTarget.getBoundingClientRect();
            const move = (y: number) => {
              if (!bar) return;
              const f = Math.min(Math.max((y - track.top) / track.height, 0), 1);
              paneRef.current?.scrollTo(Math.round(f * bar.total - bar.len / 2));
            };
            move(e.clientY);
            const onMove = (ev: MouseEvent) => move(ev.clientY);
            const onUp = () => {
              window.removeEventListener('mousemove', onMove);
              window.removeEventListener('mouseup', onUp);
              endScrollDrag.current = undefined;
            };
            endScrollDrag.current = onUp;
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
          }}
        >
          <div className="term-scrollbar-thumb" style={thumb} />
        </div>
      )}
      {math && <MathPopover math={math} cw={cell.cw} ch={cell.ch} />}
      {findHere && <FindBar m={m} terminal={terminal} />}
      {drop && (
        <div className="pane-drop">
          <span>{dropLabel(m, terminal)}</span>
        </div>
      )}
      {closed && (
        <div className="term-ended soft">
          <span>{closed.code !== undefined ? t('term.exitedCode', { code: closed.code }) : closedText(closed.reason)}</span>
        </div>
      )}
    </div>
  );
}
