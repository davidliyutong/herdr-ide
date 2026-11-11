// Formulas rendered by KaTeX, which is loaded with its stylesheet the first
// time one is shown, so pages that never show one do not load it.
//
// The formulas come from pane text, which programs control. KaTeX is made
// for such input as long as `trust` stays off (no \href, \url, \includegraphics,
// HTML classes or ids), and maxExpand and maxSize bound macro expansion and
// sizes.

import type Katex from 'katex';

let katex: Promise<typeof Katex> | undefined;

function load(): Promise<typeof Katex> {
  katex ??= Promise.all([import('katex'), import('katex/dist/katex.min.css')]).then(([m]) => m.default);
  return katex;
}

const CACHE_MAX = 200;
/** Rendered formulas, null for text KaTeX cannot read; oldest first. */
const cache = new Map<string, string | null>();

/** KaTeX's HTML for a formula, or null when it is not one KaTeX can read
 * (or KaTeX could not be loaded). */
export async function renderMath(tex: string, display: boolean): Promise<string | null> {
  const key = (display ? 'D' : 'I') + tex;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let html: string | null;
  try {
    const k = await load();
    html = k.renderToString(tex, {
      displayMode: display,
      throwOnError: true,
      strict: 'ignore',
      trust: false,
      maxExpand: 500,
      maxSize: 20,
      output: 'htmlAndMathml',
    });
  } catch {
    // A failed load is tried again next time.
    if (!(await katex?.then(() => true).catch(() => false))) {
      katex = undefined;
      return null;
    }
    html = null;
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, html);
  return html;
}
