// Find in a terminal (docs/features/26-web-terminals.md): the bar's
// state, shared by the find bar and the terminal it searches. The terminal's
// emulator searches its screen and scrollback itself, for text whose ASCII
// letters match either case; the newest match is current after typing,
// Enter goes to the next older one, Shift+Enter to the next newer one.

import { create } from 'zustand';

export interface FindState {
  /** The terminal find is open in. */
  m?: string;
  terminal?: string;
  query: string;
  total: number;
  /** The current match, 0 the newest. */
  selected?: number;
  /** Counts requests to put the keyboard in the bar. */
  focusSeq: number;
  /** Counts steps through the matches: older (1) or newer (-1) in step. */
  stepSeq: number;
  step: 1 | -1;
}

export const useFind = create<FindState>(() => ({ query: '', total: 0, focusSeq: 0, stepSeq: 0, step: 1 }));

/** Opens find in a terminal, with text as the query when given. */
export function openFind(m: string, terminal: string, text?: string) {
  useFind.setState((s) => ({
    m,
    terminal,
    query: text ?? s.query,
    focusSeq: s.focusSeq + 1,
    ...(s.m !== m || s.terminal !== terminal ? { total: 0, selected: undefined } : {}),
  }));
}

export function closeFind() {
  useFind.setState({ m: undefined, terminal: undefined, total: 0, selected: undefined });
}

export function setFindQuery(query: string) {
  useFind.setState({ query });
}

/** Goes to the next older (true) or newer match. */
export function findStep(older: boolean) {
  useFind.setState((s) => (s.terminal ? { stepSeq: s.stepSeq + 1, step: older ? 1 : -1 } : {}));
}

/** The terminal reports its matches. */
export function findResult(total: number, selected: number | undefined) {
  useFind.setState({ total, selected });
}
