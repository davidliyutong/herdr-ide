// The AI services' marks (web/src/assets/ai-logos, Lobe Icons, MIT; and
// OpenCode's, a plain block drawn here in their manner) and the color each
// one is drawn in: the service's own where it has one (Claude's clay,
// DeepSeek's blue, Grok's black or white), else a hue that keeps the
// services apart, as CodexBar does. The colors are --usage-<provider>
// (usage.css), darker in the light theme.
import { Bot, LayoutGrid } from 'lucide-react';
import claude from '../../assets/ai-logos/claude.svg?raw';
import codex from '../../assets/ai-logos/codex.svg?raw';
import grok from '../../assets/ai-logos/grok.svg?raw';
import antigravity from '../../assets/ai-logos/antigravity.svg?raw';
import kimi from '../../assets/ai-logos/kimi.svg?raw';
import deepseek from '../../assets/ai-logos/deepseek.svg?raw';

/** OpenCode: a square frame around a block, as its blocky letters are drawn. */
const opencode =
  '<svg fill="currentColor" fill-rule="evenodd" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">' +
  '<path d="M3 3h18v18H3zM6 6v12h12V6z"/><path d="M9 11h6v4H9z"/></svg>';

const MARKS: Record<string, string> = { claude, codex, grok, antigravity, kimi, deepseek, opencode };

/** The CSS color of a provider. */
export const providerColor = (provider: string) => (provider in MARKS ? `var(--usage-${provider})` : 'var(--fg-dim)');

/** A provider's mark, in its color unless plain. */
export function ProviderLogo({ provider, plain, className = '' }: { provider: string; plain?: boolean; className?: string }) {
  const style = plain ? undefined : { color: providerColor(provider) };
  const svg = MARKS[provider];
  // The marks are files of the repository, not data from elsewhere.
  if (svg) return <span className={`ai-logo ${className}`} style={style} aria-hidden dangerouslySetInnerHTML={{ __html: svg }} />;
  return (
    <span className={`ai-logo ${className}`} style={style} aria-hidden>
      <Bot />
    </span>
  );
}

/** The overview's mark. */
export function OverviewLogo({ className = '' }: { className?: string }) {
  return (
    <span className={`ai-logo ${className}`} aria-hidden>
      <LayoutGrid />
    </span>
  );
}
