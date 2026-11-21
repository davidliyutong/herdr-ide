// Text with the characters a query matched (lib/match.ts) marked, as the
// pickers and filtered trees show them.

import type { MatchRange } from '../lib/match';

export function Highlight({ text, ranges }: { text: string; ranges?: readonly MatchRange[] }) {
  if (!ranges?.length) return <>{text}</>;
  const out: React.ReactNode[] = [];
  let at = 0;
  for (const [a, b] of ranges) {
    if (a > at) out.push(text.slice(at, a));
    out.push(
      <mark key={a} className="match">
        {text.slice(a, b)}
      </mark>,
    );
    at = b;
  }
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}
