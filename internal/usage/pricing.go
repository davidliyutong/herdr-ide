package usage

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strconv"
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

// PricingWith is ModelPricing with the user's prices (own, by model name
// prefix, for every provider): one of the same name as an entry of the
// table replaces it, and the longest prefix of the two lists wins, so a
// price the user gives for a model the table does not know applies before
// a release adds it.
func (p PriceTable) PricingWith(provider, model string, own map[string]Tier) (string, *ModelPrice) {
	best, bp := p.ModelPricing(provider, model)
	for k, t := range own {
		if strings.HasPrefix(model, k) && (len(k) > len(best) || k == best) {
			best, bp = k, &ModelPrice{Source: "usage.prices", Tiers: []Tier{t}}
		}
	}
	return best, bp
}

// MaxOwnPrices bounds the user's prices.
const MaxOwnPrices = 50

var ownModel = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}$`)

// ParsePrices reads the user's prices (setting usage.prices): one model per
// line, "<model> <input> <cached> <output> [<cache write>]", in USD per
// million tokens, the model a prefix of the names it prices (as the
// table's). A price applies to prompts of any length; cache writes cost
// the input price unless given (1-hour ones twice that).
func ParsePrices(lines []string) (map[string]Tier, error) {
	if len(lines) > MaxOwnPrices {
		return nil, fmt.Errorf("at most %d prices", MaxOwnPrices)
	}
	out := map[string]Tier{}
	for _, l := range lines {
		f := strings.Fields(l)
		if len(f) == 0 {
			continue
		}
		if len(f) < 4 || len(f) > 5 || !ownModel.MatchString(f[0]) {
			return nil, fmt.Errorf("%q: a price is: model input cached output [cache write], in USD per million tokens", l)
		}
		var n [4]float64
		for i, x := range f[1:] {
			v, err := strconv.ParseFloat(x, 64)
			if err != nil || math.IsNaN(v) || v < 0 || v > 10000 {
				return nil, fmt.Errorf("%q: prices are numbers from 0 to 10000", l)
			}
			n[i] = v
		}
		if _, dup := out[f[0]]; dup {
			return nil, errors.New("a model has two prices: " + f[0])
		}
		t := Tier{Input: n[0], Cached: n[1], Output: n[2]}
		if len(f) == 5 {
			w := n[3]
			t.CacheWrite = &w
		}
		out[f[0]] = t
	}
	return out, nil
}

// ValidPrices checks the user's prices as ParsePrices makes them: at most
// MaxOwnPrices, names as ownModel, prices from 0 to 10000. The agent
// refuses others (CostOptions.Prices), so a scan never prices with them.
func ValidPrices(own map[string]Tier) error {
	if len(own) > MaxOwnPrices {
		return fmt.Errorf("at most %d prices", MaxOwnPrices)
	}
	ok := func(v float64) bool { return !math.IsNaN(v) && v >= 0 && v <= 10000 }
	for k, t := range own {
		if !ownModel.MatchString(k) || t.InputMax != nil || t.CacheWrite1h != nil ||
			!ok(t.Input) || !ok(t.Cached) || !ok(t.Output) || t.CacheWrite != nil && !ok(*t.CacheWrite) {
			return fmt.Errorf("a price that is not one of usage.prices: %q", k)
		}
	}
	return nil
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
