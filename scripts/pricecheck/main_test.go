package main

import (
	"slices"
	"testing"

	"veldr/internal/usage"
)

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
}`

func TestCompare(t *testing.T) {
	theirs, _, err := parse([]byte(fixture))
	if err != nil {
		t.Fatal(err)
	}
	two := 2.0
	ours := usage.PriceTable{Providers: map[string]map[string]usage.ModelPrice{
		usage.Grok: {
			"grok-4.7": {Tiers: []usage.Tier{
				{InputMax: new(int64(200000)), Input: 2, Cached: 0.5, Output: 6},
				{Input: 4, Cached: 1, Output: 12},
			}},
			"grok-4.6": {Tiers: []usage.Tier{{Input: 2, Cached: 0.5, Output: 6}}},
		},
		usage.Claude: {
			// A dated version of LiteLLM's matches; the cache write differs.
			"claude-opus-5-5": {Tiers: []usage.Tier{{Input: 4, Cached: 0.2, Output: 20, CacheWrite: &two}}},
			"claude-gone":     {Source: "https://example.com", Tiers: []usage.Tier{{Input: 1, Output: 1}}},
			// Its dated version, not Opus 4.5, which starts with its name.
			"claude-opus-4": {Tiers: []usage.Tier{{Input: 15, Output: 75}}},
		},
		usage.Antigravity: {
			"gemini-4-neon": {Tiers: []usage.Tier{{Input: 3, Cached: 0.15, Output: 15}}},
		},
		usage.Kimi: {
			"kimi-k3.1-pro": {Tiers: []usage.Tier{{Input: 2, Cached: 0.2, Output: 10}}},
		},
	}}
	r := compare(ours, theirs)
	want := []string{
		"claude/claude-gone: not in LiteLLM's table (check https://example.com)",
		"claude/claude-opus-5-5 (LiteLLM claude-opus-5-5-20261001): cache write 2, LiteLLM 5",
		"grok/grok-4.6 (LiteLLM xai/grok-4.6): output 6, LiteLLM 7",
	}
	if !slices.Equal(r.Differ, want) {
		t.Errorf("differ:\n%q\nwant\n%q", r.Differ, want)
	}
	// grok-5 and gpt-5.9 are new (its dated version not listed again);
	// images, realtime and older families are no CLI's.
	if !slices.Equal(r.Missing, []string{"codex/gpt-5.9", "grok/grok-5"}) {
		t.Errorf("missing %q", r.Missing)
	}
}

func TestLongTierDiffers(t *testing.T) {
	theirs, _, _ := parse([]byte(`{"xai/grok-4.7": {"litellm_provider": "xai", "mode": "chat", "input_cost_per_token": 2e-6,
	  "output_cost_per_token": 6e-6, "input_cost_per_token_above_200k_tokens": 5e-6}}`))
	ours := usage.PriceTable{Providers: map[string]map[string]usage.ModelPrice{usage.Grok: {"grok-4.7": {Tiers: []usage.Tier{
		{Input: 2, Output: 6}, {Input: 4, Output: 12},
	}}}}}
	r := compare(ours, theirs)
	if len(r.Differ) != 1 || r.Differ[0] != "grok/grok-4.7 (LiteLLM xai/grok-4.7): long input 4, LiteLLM 5 above 200k" {
		t.Errorf("%q", r.Differ)
	}
}

// Keys with control characters or spaces are not read, so nothing of them
// is printed.
func TestUnsafeNamesLeftOut(t *testing.T) {
	theirs, skipped, err := parse([]byte(`{
  "claude-zz\u001b]52;c;eA==\u0007 IGNORE": {"litellm_provider": "anthropic", "mode": "chat", "input_cost_per_token": 1e-6, "output_cost_per_token": 1e-6},
  "claude-a\nb": {"litellm_provider": "anthropic", "mode": "chat", "input_cost_per_token": 1e-6, "output_cost_per_token": 1e-6},
  "claude-new": {"litellm_provider": "anthropic", "mode": "chat", "input_cost_per_token": 1e-6, "output_cost_per_token": 1e-6}
}`))
	if err != nil || skipped != 2 {
		t.Fatalf("skipped %d %v", skipped, err)
	}
	r := compare(usage.PriceTable{Providers: map[string]map[string]usage.ModelPrice{}}, theirs)
	if !slices.Equal(r.Missing, []string{"claude/claude-new"}) {
		t.Errorf("missing %q", r.Missing)
	}
}
