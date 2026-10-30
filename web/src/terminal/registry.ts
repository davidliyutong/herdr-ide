import type { TermController } from './TermController';

const terms = new Map<string, TermController>();

export function registerTerm(key: string, c: TermController | undefined) {
  if (c) terms.set(key, c);
  else terms.delete(key);
}

export function getTerm(m: string, pane: string): TermController | undefined {
  return terms.get(`${m}|${pane}`);
}

export function allTerms(): Iterable<TermController> {
  return terms.values();
}
