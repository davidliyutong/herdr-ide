package usage

import (
	_ "embed"
	"encoding/json"
	"strings"
)

// Tier is a price tier ($ per million tokens) for prompts shorter than
// InputMax (nil: any length).
type Tier struct {
	InputMax     *int64   `json:"inputMax"`
	Input        float64  `json:"input"`
	Cached       float64  `json:"cached"`
	Output       float64  `json:"output"`
	CacheWrite   *float64 `json:"cacheWrite,omitempty"`
	CacheWrite1h *float64 `json:"cacheWrite1h,omitempty"`
}

// ModelPrice is a model's tiers.
type ModelPrice struct {
	Source string `json:"source"`
	Tiers  []Tier `json:"tiers"`
}

// PriceTable is pricing.json: the API prices the cost scanner applies,
// ported from the user's ai-usage skill, and the hours of a week and of a
// month for the weekly and monthly equivalents.
type PriceTable struct {
	WeekHours  float64                          `json:"weekHours"`
	MonthHours float64                          `json:"monthHours"`
	Providers  map[string]map[string]ModelPrice `json:"providers"`
}

//go:embed pricing.json
var pricingJSON []byte

// Pricing is the embedded price table.
var Pricing = func() PriceTable {
	var p PriceTable
	if err := json.Unmarshal(pricingJSON, &p); err != nil {
		panic("usage: pricing.json: " + err.Error())
	}
	return p
}()

// ModelPricing is the price of a model: the entry whose name is the
// longest prefix of model; "" when none is.
func (p PriceTable) ModelPricing(provider, model string) (string, *ModelPrice) {
	best := ""
	var bp *ModelPrice
	for k, v := range p.Providers[provider] {
		if strings.HasPrefix(model, k) && len(k) > len(best) {
			v := v
			best, bp = k, &v
		}
	}
	return best, bp
}

// Tier picks the tier of a prompt of n tokens: the first whose InputMax
// is at least n ("100K tokens or fewer").
func (m *ModelPrice) Tier(n int64) (int, Tier) {
	for i, t := range m.Tiers {
		if t.InputMax == nil || n <= *t.InputMax {
			return i, t
		}
	}
	return len(m.Tiers) - 1, m.Tiers[len(m.Tiers)-1]
}

// Cost is the price of tokens at t, in USD.
func (t Tier) Cost(input, cached, cw5, cw1, output int64) float64 {
	w5, w1 := t.Input, 2*t.Input
	if t.CacheWrite != nil {
		w5 = *t.CacheWrite
	}
	if t.CacheWrite1h != nil {
		w1 = *t.CacheWrite1h
	}
	return (float64(input)*t.Input + float64(cached)*t.Cached + float64(cw5)*w5 + float64(cw1)*w1 + float64(output)*t.Output) / 1e6
}
