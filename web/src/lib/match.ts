// Matching a query against a label, as the command palette, the pickers
// (components/Picker.tsx) and filtered trees do: how well it matches and
// which characters matched, to highlight them (components/Highlight.tsx).

/** A range of matched characters, [start, end). */
export type MatchRange = readonly [number, number];

export interface Match {
  /** 3 when a word starts with the query, 2 when the label holds it, 1
   * when its letters are the starts of words or follow each other there
   * ("fpl" for "Focus Pane Left", "spri" for "Split Right"). */
  score: 1 | 2 | 3;
  ranges: MatchRange[];
}

const wordStart = (s: string, i: number) => i === 0 || /[\s·:/\\(（._-]/.test(s[i - 1]);

/** How the query matches the text (case ignored), undefined when it does
 * not. An empty query matches everything with no ranges. */
export function match(query: string, text: string): Match | undefined {
  const q = query.toLowerCase().trim();
  if (!q) return { score: 3, ranges: [] };
  const s = text.toLowerCase();
  // The text holding the query: at a word's start if it does anywhere.
  let first = -1;
  for (let at = s.indexOf(q); at >= 0; at = s.indexOf(q, at + 1)) {
    if (wordStart(s, at)) return { score: 3, ranges: [[at, at + q.length]] };
    if (first < 0) first = at;
  }
  if (first >= 0) return { score: 2, ranges: [[first, first + q.length]] };
  // Its letters in order, each following the last or starting a word.
  const hits: number[] = [];
  let j = -1;
  for (const ch of q) {
    let k = j + 1;
    while (k < s.length && !(s[k] === ch && (k === j + 1 || wordStart(s, k)))) k++;
    if (k >= s.length) return undefined;
    hits.push(k);
    j = k;
  }
  const ranges: Array<[number, number]> = [];
  for (const h of hits) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] === h) last[1] = h + 1;
    else ranges.push([h, h + 1]);
  }
  return { score: 1, ranges };
}

/** The score of match (0 when it does not match). */
export function matchScore(query: string, text: string): number {
  return match(query, text)?.score ?? 0;
}
