// Compare the AI usage plugin's price table (internal/usage/pricing.json)
// with LiteLLM's public one, which follows the providers' price pages, for
// a release (RELEASING.md): the table's models whose prices differ there,
// and the models of the families the table prices that it does not know.
// Nothing is written: pricing.json is edited by hand from the providers'
// own pages, which stay the source.
//
//	go run ./scripts/pricecheck              # fetches LiteLLM's table
//	go run ./scripts/pricecheck -src FILE    # a copy of it
//
// The exit status is 1 when something differs or is missing. The table is
// someone else's: a model name with other characters than those of model
// names (letters, digits, . _ : / @ -) is left out and counted, so the
// output carries no control characters or text of its own.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"regexp"
	"slices"
	"sort"
	"strings"
	"time"

	"veldr/internal/usage"
)

const litellmURL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"

// maxBody bounds the table read (it is a few MB).
const maxBody = 64 << 20

// entry is what this script reads of a model of LiteLLM's table (USD per
// token).
type entry struct {
	Provider   string   `json:"litellm_provider"`
	Mode       string   `json:"mode"`
	Input      *float64 `json:"input_cost_per_token"`
	Output     *float64 `json:"output_cost_per_token"`
	Cached     *float64 `json:"cache_read_input_token_cost"`
	CacheWrite *float64 `json:"cache_creation_input_token_cost"`
	// The long-context prices, under keys such as
	// input_cost_per_token_above_200k_tokens.
	Long map[string]float64 `json:"-"`
}

// families are, per provider of the table, LiteLLM's provider and the
// model names the CLIs the plugin reads use.
var families = map[string]struct {
	litellm string
	names   *regexp.Regexp
}{
	usage.Grok:        {"xai", regexp.MustCompile(`^grok-[0-9]`)},
	usage.Claude:      {"anthropic", regexp.MustCompile(`^claude-`)},
	usage.Codex:       {"openai", regexp.MustCompile(`^gpt-[5-9]`)},
	usage.Antigravity: {"gemini", regexp.MustCompile(`^gemini-(2\.5|[3-9])`)},
	usage.Kimi:        {"moonshot", regexp.MustCompile(`^kimi-`)},
}

// notCLI are LiteLLM's models of those families that are no CLI's.
var notCLI = regexp.MustCompile(`(audio|realtime|image|tts|transcribe|search|chat-latest|-instant|live|embed|robotics|computer|customtools|-exp)`)

var longKey = regexp.MustCompile(`^(input|output)_cost_per_token_above_(\d+)k_tokens$`)

// safeName is what a model's key may be to be read at all.
var safeName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$`)

// parse reads LiteLLM's table; skipped counts the keys left out (safeName).
func parse(b []byte) (out map[string]entry, skipped int, err error) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(b, &raw); err != nil {
		return nil, 0, err
	}
	out = map[string]entry{}
	for k, v := range raw {
		if !safeName.MatchString(k) {
			skipped++
			continue
		}
		var e entry
		if json.Unmarshal(v, &e) != nil {
			continue
		}
		var all map[string]any
		if json.Unmarshal(v, &all) == nil {
			for f, x := range all {
				if n, ok := x.(float64); ok && longKey.MatchString(f) {
					if e.Long == nil {
						e.Long = map[string]float64{}
					}
					e.Long[f] = n
				}
			}
		}
		out[k] = e
	}
	return out, skipped, nil
}

// name is a LiteLLM key without its provider prefix (xai/grok-4.7).
func name(key string) string {
	if i := strings.LastIndexByte(key, '/'); i >= 0 {
		return key[i+1:]
	}
	return key
}

// dated is a version suffix of a model's name: -20251101, -2025-08-07,
// -0309.
var dated = regexp.MustCompile(`-(\d{8}|\d{4}-\d{2}-\d{2}|\d{4})$`)

// match is LiteLLM's model for an entry of the table: its own name, else a
// dated version of it (the earliest).
func match(theirs map[string]entry, litellm, model string) (string, entry, bool) {
	best := ""
	var be entry
	for k, e := range theirs {
		n := name(k)
		if e.Provider != litellm || e.Input == nil || e.Output == nil {
			continue
		}
		exact := n == model
		if !exact && !(strings.HasPrefix(n, model) && dated.MatchString(n) && dated.ReplaceAllString(n, "") == model) {
			continue
		}
		if best == "" || exact && name(best) != model || (exact == (name(best) == model)) && n < name(best) {
			best, be = k, e
		}
	}
	return best, be, best != ""
}

func perM(p *float64) float64 { return math.Round(*p*1e6*1e6) / 1e6 }

func near(a, b float64) bool { return math.Abs(a-b) < 1e-6 }

// report is what differs: a line per finding, sorted.
type report struct {
	Differ  []string
	Missing []string
}

func compare(ours usage.PriceTable, theirs map[string]entry) report {
	var r report
	for prov, models := range ours.Providers {
		f, ok := families[prov]
		if !ok {
			continue
		}
		for model, mp := range models {
			key, e, ok := match(theirs, f.litellm, model)
			if !ok {
				r.Differ = append(r.Differ, fmt.Sprintf("%s/%s: not in LiteLLM's table (check %s)", prov, model, mp.Source))
				continue
			}
			t := mp.Tiers[0]
			var d []string
			check := func(what string, mine float64, p *float64) {
				if p != nil && !near(mine, perM(p)) {
					d = append(d, fmt.Sprintf("%s %g, LiteLLM %g", what, mine, perM(p)))
				}
			}
			check("input", t.Input, e.Input)
			check("output", t.Output, e.Output)
			check("cached", t.Cached, e.Cached)
			if t.CacheWrite != nil {
				check("cache write", *t.CacheWrite, e.CacheWrite)
			}
			if len(mp.Tiers) == 1 && len(e.Long) > 0 {
				d = append(d, "LiteLLM has a long-context price, the table one price")
			}
			if len(mp.Tiers) > 1 {
				long := mp.Tiers[1]
				for f, v := range e.Long {
					m := longKey.FindStringSubmatch(f)
					mine := long.Input
					if m[1] == "output" {
						mine = long.Output
					}
					if !near(mine, math.Round(v*1e12)/1e6) {
						d = append(d, fmt.Sprintf("long %s %g, LiteLLM %g above %sk", m[1], mine, math.Round(v*1e12)/1e6, m[2]))
					}
				}
			}
			if len(d) > 0 {
				sort.Strings(d)
				r.Differ = append(r.Differ, fmt.Sprintf("%s/%s (LiteLLM %s): %s", prov, model, key, strings.Join(d, "; ")))
			}
		}
	}
	seen := map[string]bool{}
	for k, e := range theirs {
		for prov, f := range families {
			n := name(k)
			if e.Provider != f.litellm || e.Mode != "chat" && e.Mode != "responses" || !f.names.MatchString(n) || notCLI.MatchString(n) {
				continue
			}
			if _, mp := ours.ModelPricing(prov, n); mp == nil && !seen[prov+"/"+n] {
				seen[prov+"/"+n] = true
				r.Missing = append(r.Missing, prov+"/"+n)
			}
		}
	}
	// A dated version of a model listed is not listed again.
	r.Missing = slices.DeleteFunc(r.Missing, func(m string) bool {
		return dated.MatchString(m) && seen[dated.ReplaceAllString(m, "")]
	})
	sort.Strings(r.Differ)
	sort.Strings(r.Missing)
	return r
}

func fetch(url string) ([]byte, error) {
	c := &http.Client{Timeout: 60 * time.Second, CheckRedirect: func(req *http.Request, _ []*http.Request) error {
		if req.URL.Scheme != "https" || req.URL.Host != "raw.githubusercontent.com" {
			return fmt.Errorf("redirect to %s refused", req.URL.Redacted())
		}
		return nil
	}}
	resp, err := c.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s: %s", url, resp.Status)
	}
	return io.ReadAll(io.LimitReader(resp.Body, maxBody))
}

func main() {
	src := flag.String("src", "", "a copy of LiteLLM's model_prices_and_context_window.json (default: fetch it)")
	flag.Parse()
	var b []byte
	var err error
	if *src != "" {
		b, err = os.ReadFile(*src)
	} else {
		b, err = fetch(litellmURL)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "pricecheck:", err)
		os.Exit(2)
	}
	theirs, skipped, err := parse(b)
	if err != nil {
		fmt.Fprintln(os.Stderr, "pricecheck:", err)
		os.Exit(2)
	}
	if skipped > 0 {
		fmt.Printf("skipped: %d model keys with characters model names do not have\n", skipped)
	}
	r := compare(usage.Pricing, theirs)
	for _, l := range r.Differ {
		fmt.Println("differs:", l)
	}
	for _, l := range r.Missing {
		fmt.Println("missing:", l)
	}
	if len(r.Differ)+len(r.Missing) > 0 {
		fmt.Println("Check each against the provider's price page, then edit internal/usage/pricing.json.")
		os.Exit(1)
	}
	fmt.Println("pricing.json agrees with LiteLLM's table.")
}
