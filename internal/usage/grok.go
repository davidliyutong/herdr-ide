package usage

import (
	"context"
	"encoding/json"
	"path"
	"sort"
	"strings"
)

func grokHome(e *Env) string {
	if h := e.getenv("GROK_HOME"); h != "" {
		return e.expand(h)
	}
	return path.Join(e.Home, ".grok")
}

// grokAccounts reads the Grok subscription's credits: ~/.grok/auth.json
// (an entry per issuer scope; x.ai's own first), GET /v1/billing and
// /v1/settings for the plan.
func grokAccounts(ctx context.Context, e *Env, o *Options) []Account {
	b, err := readFile(path.Join(grokHome(e), "auth.json"))
	if err != nil {
		return []Account{{Provider: Grok, Status: StatusMissing}}
	}
	var entries map[string]json.RawMessage
	if json.Unmarshal(b, &entries) != nil {
		return []Account{{Provider: Grok, Status: StatusMissing, Code: "bad_credentials"}}
	}
	keys := make([]string, 0, len(entries))
	for k := range entries {
		keys = append(keys, k)
	}
	// x.ai's own issuer first, then the others in a stable order.
	sort.Slice(keys, func(i, j int) bool {
		pi, pj := strings.HasPrefix(keys[i], "https://auth.x.ai::"), strings.HasPrefix(keys[j], "https://auth.x.ai::")
		if pi != pj {
			return pi
		}
		return keys[i] < keys[j]
	})
	type grokEntry struct {
		Key       string `json:"key"`
		ExpiresAt any    `json:"expires_at"`
		Email     string `json:"email"`
		UserID    string `json:"user_id"`
	}
	var entry grokEntry
	found := false
	for _, k := range keys {
		// Each entry on its own: one without a key lends nothing to the next.
		var e grokEntry
		if json.Unmarshal(entries[k], &e) == nil && e.Key != "" {
			entry, found = e, true
			break
		}
	}
	if !found {
		return []Account{{Provider: Grok, Status: StatusMissing, Code: "no_key"}}
	}
	a := Account{Provider: Grok, ID: entry.UserID, Email: entry.Email, Source: "api"}
	if o.skips(Grok, a.ID, "") {
		return []Account{skipped(a)}
	}
	if exp := timeOf(entry.ExpiresAt); exp > 0 && exp < e.now().Unix() {
		a.Status, a.Code = StatusStale, "token_expired"
		return []Account{a}
	}
	headers := map[string]string{"Authorization": "Bearer " + entry.Key, "X-XAI-Token-Auth": "xai-grok-cli"}
	m, err := getMap(ctx, e.Client, "GET", e.URLs.GrokBilling, headers, nil)
	if err != nil {
		return []Account{failed(a, err)}
	}
	parseGrokBilling(&a, m)
	if s, err := getMap(ctx, e.Client, "GET", e.URLs.GrokSettings, headers, nil); err == nil {
		a.Plan = str(first(s, "subscription_tier_display", "subscriptionTierDisplay"))
	}
	a.Status, a.AsOf = StatusOK, e.now().Unix()
	return []Account{a}
}

// parseGrokBilling reads config.creditUsagePercent (else onDemandUsed and
// onDemandCap), config.currentPeriod and config.productUsage.
func parseGrokBilling(a *Account, m map[string]any) {
	c := obj(m["config"])
	if c == nil {
		c = m
	}
	period := obj(c["currentPeriod"])
	start, end := timeOf(period["start"]), timeOf(period["end"])
	sec := int64(0)
	if start > 0 && end > start {
		sec = end - start
	}
	pct, ok := num(c["creditUsagePercent"])
	if !ok {
		used, ok1 := num(obj(c["onDemandUsed"])["val"])
		limit, ok2 := num(obj(c["onDemandCap"])["val"])
		if ok1 && ok2 && limit > 0 {
			pct, ok = used/limit*100, true
		}
	}
	if ok {
		a.Windows = append(a.Windows, Window{Kind: KindMonthly, UsedPct: clampPct(pct), ResetsAt: end, WindowSec: sec})
	}
	for _, x := range arr(c["productUsage"]) {
		x := obj(x)
		label := str(first(x, "product", "name", "label", "model"))
		p, ok := num(first(x, "usagePercent", "creditUsagePercent", "percent", "usedPercent"))
		if label == "" || !ok {
			continue
		}
		a.Windows = append(a.Windows, Window{Kind: KindModel, Label: label, UsedPct: clampPct(p), ResetsAt: end, WindowSec: sec})
	}
	used, ok1 := num(obj(c["onDemandUsed"])["val"])
	limit, ok2 := num(obj(c["onDemandCap"])["val"])
	if ok1 || ok2 {
		cr := &Credits{Unit: "credits"}
		if ok1 {
			cr.Used = floatPtr(used)
		}
		if ok2 {
			cr.Limit = floatPtr(limit)
		}
		a.Credits = cr
	}
}
