// Colors code by the roles of its tokens (roles.ts) with Shiki's grammars
// (languages.ts). Shiki and each grammar load on first use, so the main
// bundle carries neither; regular expressions run in the browser's own
// engine, without a second WebAssembly module.

import type { HighlighterCore } from 'shiki/core';
import { langOf, type Lang } from './languages';
import { ROLE_THEME, roleOfColor, roleTheme, type Role } from './roles';

/** Text of one role (none: plain text). */
export interface Piece {
  text: string;
  role?: Role;
}

/** Code longer than this stays plain: tokenizing runs on the page's thread. */
export const MAX_HIGHLIGHT = 300_000;

/** A line longer than this is not tokenized (minified files). */
const MAX_LINE = 20_000;
/** The most time a line may take, in ms. */
const LINE_TIME = 500;

let core: Promise<HighlighterCore> | undefined;

function highlighter(): Promise<HighlighterCore> {
  core ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
    ]);
    // A pattern the browser's engine cannot run is skipped, not an error:
    // the rest of the grammar still colors.
    return createHighlighterCore({ themes: [roleTheme], langs: [], engine: createJavaScriptRegexEngine({ forgiving: true }) });
  })().catch((e) => {
    core = undefined;
    throw e;
  });
  return core;
}

const grammars = new Map<string, Promise<HighlighterCore>>();

/** The highlighter with l's grammar loaded. */
function withLanguage(l: Lang): Promise<HighlighterCore> {
  let p = grammars.get(l.id);
  if (!p) {
    p = highlighter()
      .then(async (hl) => {
        await hl.loadLanguage(l.grammar);
        return hl;
      })
      .catch((e) => {
        grammars.delete(l.id);
        throw e;
      });
    grammars.set(l.id, p);
  }
  return p;
}

const nameOf = (l: Lang) => l.shiki ?? l.id;

function join(pieces: Piece[]): Piece[] {
  const out: Piece[] = [];
  for (const p of pieces) {
    const last = out[out.length - 1];
    if (last && last.role === p.role) last.text += p.text;
    else if (p.text) out.push({ ...p });
  }
  return out;
}

/** Code as lines of pieces by role, in the language of id (languages.ts).
 * Undefined for a language that is none of ours and for code too long to
 * color. */
export async function highlight(code: string, id: string | undefined): Promise<Piece[][] | undefined> {
  const l = langOf(id);
  if (!l || code.length > MAX_HIGHLIGHT) return undefined;
  const hl = await withLanguage(l);
  const lines = hl.codeToTokensBase(code, {
    lang: nameOf(l),
    theme: ROLE_THEME,
    tokenizeMaxLineLength: MAX_LINE,
    tokenizeTimeLimit: LINE_TIME,
  });
  return lines.map((line) => join(line.map((t) => ({ text: t.content, role: roleOfColor(t.color) }))));
}

/** A language's tokenizer line by line, for an editor that keeps a state
 * per line. */
export interface LineTokenizer<S = unknown> {
  initial: S;
  /** The roles of a line from the state its predecessor ended in: where
   * each run starts, and the state the line ends in. */
  line(text: string, state: S): { state: S; tokens: { start: number; role?: Role }[] };
  same(a: S, b: S): boolean;
}

/** The line tokenizer of the language of id; undefined when it is none of
 * ours. */
export async function lineTokenizer(id: string): Promise<LineTokenizer | undefined> {
  const l = langOf(id);
  if (!l) return undefined;
  const [hl, { EncodedTokenMetadata, INITIAL }] = await Promise.all([withLanguage(l), import('shiki/textmate')]);
  const grammar = hl.getLanguage(nameOf(l));
  const roles = hl.setTheme(ROLE_THEME).colorMap.map(roleOfColor);
  type Stack = typeof INITIAL;
  const t: LineTokenizer<Stack> = {
    initial: INITIAL,
    line(text, state) {
      if (text.length >= MAX_LINE) return { state, tokens: [{ start: 0 }] };
      const r = grammar.tokenizeLine2(text, state, LINE_TIME);
      const tokens: { start: number; role?: Role }[] = [];
      for (let i = 0; i < r.tokens.length; i += 2) {
        const role = roles[EncodedTokenMetadata.getForeground(r.tokens[i + 1])];
        const last = tokens[tokens.length - 1];
        if (!last || last.role !== role) tokens.push({ start: r.tokens[i], role });
      }
      return { state: r.ruleStack, tokens };
    },
    same: (a, b) => a === b || a.equals(b),
  };
  return t as LineTokenizer;
}
