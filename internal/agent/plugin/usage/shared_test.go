//go:build unix

package usage

import (
	"encoding/json"
	"testing"

	"herdr-ide/internal/agent/plugin"
)

// Limits one core fetched answer another core's same request; not the same
// core's (a refresh), nor other params.
func TestLimitsSharedBetweenCores(t *testing.T) {
	a := &plugin.Env{Base: "/h/.x", Client: "a"}
	b := &plugin.Env{Base: "/h/.x", Client: "b"}
	params := json.RawMessage(`{"kimi":true}`)
	limitsBy(a, params, []string{"acc"})
	if acc, ok := sharedLimits(b, params); !ok || acc.([]string)[0] != "acc" {
		t.Fatal("not shared")
	}
	if _, ok := sharedLimits(a, params); ok {
		t.Fatal("shared with the same core")
	}
	if _, ok := sharedLimits(b, json.RawMessage(`{}`)); ok {
		t.Fatal("shared for other params")
	}
}
