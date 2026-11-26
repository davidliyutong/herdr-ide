// The price table's comparison with LiteLLM's (RELEASING.md).
import { expect, test } from 'bun:test';
import { compare, parse, type PriceTable } from './pricecheck.ts';

const fixture = `{
  "sample_spec": {"litellm_provider": "openai", "mode": "chat"},
  "xai/grok-4.7": {"litellm_provider": "xai", "mode": "chat", "input_cost_per_token": 2e-6, "output_cost_per_token": 6e-6,
    "cache_read_input_token_cost": 5e-7, "input_cost_per_token_above_200k_tokens": 4e-6, "output_cost_per_token_above_200k_tokens": 1.2e-5},
  "xai/grok-4.6": {"litellm_provider": "xai", "mode": "chat", "input_cost_per_token": 2e-6, "output_cost_per_token": 7e-6},
  "xai/grok-5": {"litellm_provider": "xai", "mode": "chat", "input_cost_per_token": 3e-6, "output_cost_per_token": 9e-6},
  "xai/grok-5-image": {"litellm_provider": "xai", "mode": "image_generation", "input_cost_per_token": 1e-6, "output_cost_per_token": 1e-6},
  "claude-opus-5-5-20261001": {"litellm_provider": "anthropic", "mode": "chat", "input_cost_per_token": 4e-6, "output_cost_per_token": 2e-5,
    "cache_read_input_token_cost": 2e-7, "cache_creation_input_token_cost": 5e-6},
  "gpt-5.9-realtime": {"litellm_provider": "openai", "mode": "chat", "input_cost_per_token": 1e-6, "output_cost_per_token": 1e-6},
  "claude-opus-4-20250514": {"litellm_provider": "anthropic", "mode": "chat", "input_cost_per_token": 1.5e-5, "output_cost_per_token": 7.5e-5},
  "claude-opus-4-5": {"litellm_provider": "anthropic", "mode": "chat", "input_cost_per_token": 5e-6, "output_cost_per_token": 2.5e-5},
  "gpt-5.9": {"litellm_provider": "openai", "mode": "chat", "input_cost_per_token": 1e-6, "output_cost_per_token": 1e-6},
  "gpt-5.9-2026-12-01": {"litellm_provider": "openai", "mode": "chat", "input_cost_per_token": 1e-6, "output_cost_per_token": 1e-6},
  "gpt-4o": {"litellm_provider": "openai", "mode": "chat", "input_cost_per_token": 1e-6, "output_cost_per_token": 1e-6},
  "gemini/gemini-4-neon": {"litellm_provider": "gemini", "mode": "chat", "input_cost_per_token": 3e-6, "output_cost_per_token": 1.5e-5, "cache_read_input_token_cost": 1.5e-7},
  "gemini/gemini-4-live": {"litellm_provider": "gemini", "mode": "chat", "input_cost_per_token": 1e-6, "output_cost_per_token": 1e-6},
  "moonshot/kimi-k3.1-pro": {"litellm_provider": "moonshot", "mode": "chat", "input_cost_per_token": 2e-6, "output_cost_per_token": 1e-5, "cache_read_input_token_cost": 2e-7}
}`;

test('compare', () => {
  const ours: PriceTable = {
    grok: {
      'grok-4.7': {
        tiers: [
          { inputMax: 200000, input: 2, cached: 0.5, output: 6 },
          { input: 4, cached: 1, output: 12 },
        ],
      },
      'grok-4.6': { tiers: [{ input: 2, cached: 0.5, output: 6 }] },
    },
    claude: {
      // A dated version of LiteLLM's matches; the cache write differs.
      'claude-opus-5-5': { tiers: [{ input: 4, cached: 0.2, output: 20, cacheWrite: 2 }] },
      'claude-gone': { source: 'https://example.com', tiers: [{ input: 1, cached: 0, output: 1 }] },
      // Its dated version, not Opus 4.5, which starts with its name.
      'claude-opus-4': { tiers: [{ input: 15, cached: 0, output: 75 }] },
    },
    antigravity: { 'gemini-4-neon': { tiers: [{ input: 3, cached: 0.15, output: 15 }] } },
    kimi: { 'kimi-k3.1-pro': { tiers: [{ input: 2, cached: 0.2, output: 10 }] } },
  };
  const r = compare(ours, parse(fixture).entries);
  expect(r.differ).toEqual([
    "claude/claude-gone: not in LiteLLM's table (check https://example.com)",
    'claude/claude-opus-5-5 (LiteLLM claude-opus-5-5-20261001): cache write 2, LiteLLM 5',
    'grok/grok-4.6 (LiteLLM xai/grok-4.6): output 6, LiteLLM 7',
  ]);
  // grok-5 and gpt-5.9 are new (its dated version not listed again);
  // images, realtime and older families are no CLI's.
  expect(r.missing).toEqual(['codex/gpt-5.9', 'grok/grok-5']);
});

test('a long tier that differs', () => {
  const theirs = parse(`{"xai/grok-4.7": {"litellm_provider": "xai", "mode": "chat", "input_cost_per_token": 2e-6,
    "output_cost_per_token": 6e-6, "input_cost_per_token_above_200k_tokens": 5e-6}}`).entries;
  const ours: PriceTable = {
    grok: {
      'grok-4.7': {
        tiers: [
          { input: 2, cached: 0, output: 6 },
          { input: 4, cached: 0, output: 12 },
        ],
      },
    },
  };
  expect(compare(ours, theirs).differ).toEqual(['grok/grok-4.7 (LiteLLM xai/grok-4.7): long input 4, LiteLLM 5 above 200k']);
});

// Keys with control characters or spaces are not read, so nothing of them
// is printed.
test('unsafe names are left out', () => {
  const { entries, skipped } = parse(`{
  "claude-zz\\u001b]52;c;eA==\\u0007 IGNORE": {"litellm_provider": "anthropic", "mode": "chat", "input_cost_per_token": 1e-6, "output_cost_per_token": 1e-6},
  "claude-a\\nb": {"litellm_provider": "anthropic", "mode": "chat", "input_cost_per_token": 1e-6, "output_cost_per_token": 1e-6},
  "claude-new": {"litellm_provider": "anthropic", "mode": "chat", "input_cost_per_token": 1e-6, "output_cost_per_token": 1e-6}
}`);
  expect(skipped).toBe(2);
  expect(compare({}, entries).missing).toEqual(['claude/claude-new']);
});
