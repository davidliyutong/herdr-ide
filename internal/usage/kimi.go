package usage

import (
	"context"
	"errors"
	"math"
	"os"
	"path"
	"sort"
	"strings"
)

func kimiHome(e *Env) string {
	if h := e.getenv("KIMI_CODE_HOME"); h != "" {
		return e.expand(h)
	}
	return path.Join(e.Home, ".kimi-code")
}

// kimiAccounts reads Kimi Code's weekly quota and its shorter windows:
// ~/.kimi-code/credentials/kimi-code*.json, GET /coding/v1/usages. With
// Options.KimiRefresh an access token that has ended (or is about to) is
// renewed first as Kimi Code renews it (kimiauth.go).
func kimiAccounts(ctx context.Context, e *Env, o *Options) []Account {
	dir := path.Join(kimiHome(e), "credentials")
	ents, err := os.ReadDir(dir)
	if err != nil {
		return []Account{{Provider: Kimi, Status: StatusMissing}}
	}
	var files []string
	for _, ent := range ents {
		n := ent.Name()
		if !ent.IsDir() && strings.HasPrefix(n, "kimi-code") && strings.HasSuffix(n, ".json") {
			files = append(files, n)
		}
	}
	// kimi-code.json first.
	sort.Slice(files, func(i, j int) bool {
		if (files[i] == "kimi-code.json") != (files[j] == "kimi-code.json") {
			return files[i] == "kimi-code.json"
		}
		return files[i] < files[j]
	})
	var out []Account
	for _, f := range files {
		out = append(out, kimiAccount(ctx, e, o, path.Join(dir, f)))
	}
	if len(out) == 0 {
		return []Account{{Provider: Kimi, Status: StatusMissing}}
	}
	return out
}

func kimiAccount(ctx context.Context, e *Env, o *Options, file string) Account {
	a := Account{Provider: Kimi, Source: "api"}
	tok, _, err := readKimiToken(file)
	if err != nil || tok.AccessToken == "" {
		a.Status = StatusMissing
		return a
	}
	if c := jwtClaims(tok.AccessToken); c != nil {
		a.ID = str(first(c, "user_id", "sub", "uid"))
		a.Email = str(c["email"])
	}
	if o.skips(Kimi, a.ID, "") {
		return skipped(a)
	}
	if o.KimiRefresh && kimiRenewable(e, file) && tok.needsRefresh(e.now()) {
		nt, err := renewKimi(ctx, e, file)
		switch {
		case errors.Is(err, errKimiRefused):
			a.Status, a.Code = StatusUnauth, "unauthorized"
			return a
		case errors.Is(err, errKimiLockBusy):
			a.Status, a.Code = StatusStale, "lock_busy"
			return a
		case err != nil:
			return failed(a, err)
		}
		tok = nt
	}
	if exp := tok.expiresAt(); exp > 0 && exp < e.now().Unix() {
		a.Status, a.Code = StatusStale, "token_expired"
		return a
	}
	m, err := getMap(ctx, e.Client, "GET", e.URLs.KimiUsage, map[string]string{"Authorization": "Bearer " + tok.AccessToken}, nil)
	if err != nil {
		return failed(a, err)
	}
	parseKimiUsage(&a, m)
	a.Status, a.AsOf = StatusOK, e.now().Unix()
	return a
}

// kimiDetail reads {limit, used, remaining, resetTime}, whose numbers may
// be strings.
func kimiDetail(d map[string]any) (pct float64, resets int64, ok bool) {
	limit, okL := num(d["limit"])
	used, okU := num(d["used"])
	if !okU {
		if rem, okR := num(d["remaining"]); okR && okL {
			used, okU = limit-rem, true
		}
	}
	if !okL || !okU || limit <= 0 {
		return 0, 0, false
	}
	return clampPct(used / limit * 100), timeOf(first(d, "resetTime", "reset_time", "resetAt")), true
}

// parseKimiUsage reads the answer of /coding/v1/usages in either shape it
// has had: usages {limit_5h, limit_7d, limit_month_total, limit_month_code}
// (Kimi Code 2.2.0's), or usage (the weekly quota) and limits[]. With both,
// the one with more windows counts (the newer when they tie); the booster
// wallet comes with the newer.
func parseKimiUsage(a *Account, m map[string]any) {
	var older, newer Account
	parseKimiLimits(&older, m)
	parseKimiUsages(&newer, m)
	a.Windows = newer.Windows
	if len(older.Windows) > len(newer.Windows) {
		a.Windows = older.Windows
	}
	a.Credits = kimiWallet(obj(m["boosterWallet"]))
}

// parseKimiUsages reads usages: each {used_ratio (0–1, a number or a
// string), reset_time}; the month's total counts Kimi and Kimi Code, and
// limit_month_code is Kimi Code's part of it, labelled Code.
func parseKimiUsages(a *Account, m map[string]any) {
	u := obj(m["usages"])
	add := func(key, kind, label string, sec int64) {
		x := obj(u[key])
		r, ok := num(x["used_ratio"])
		if !ok {
			return
		}
		a.Windows = append(a.Windows, Window{Kind: kind, Label: label, UsedPct: clampPct(r * 100), ResetsAt: timeOf(x["reset_time"]), WindowSec: sec})
	}
	add("limit_5h", KindSession, "", 5*3600)
	add("limit_7d", KindWeekly, "", 7*86400)
	// A month taken as 30 days (for the pace; its length then does not
	// change from one month to the next).
	add("limit_month_total", KindMonthly, "", 30*86400)
	add("limit_month_code", KindMonthly, "Code", 30*86400)
}

// kimiWallet reads boosterWallet, extra usage bought beyond the plan, as
// Kimi Code reads it: a balance of type BOOSTER with amount and amountLeft
// in millionths of a cent, monthlyUsed and monthlyChargeLimit
// {priceInCents, currency}, monthlyChargeLimitEnabled. Nil without one.
func kimiWallet(w map[string]any) *Credits {
	b := obj(w["balance"])
	if str(b["type"]) != "BOOSTER" {
		return nil
	}
	if amount, ok := num(b["amount"]); !ok || amount <= 0 {
		return nil
	}
	// fixed is an amount in millionths of a cent, in currency units: at
	// least a cent when there is any.
	fixed := func(v float64) float64 {
		c := v / 1e6
		if c > 0 && c < 1 {
			c = 1
		}
		return math.Round(c) / 100
	}
	money := func(x map[string]any) (float64, string, bool) {
		c, ok := num(x["priceInCents"])
		return math.Trunc(c) / 100, str(x["currency"]), ok
	}
	left := 0.0
	if v, ok := num(b["amountLeft"]); ok {
		left = fixed(v)
	}
	limit, limitCur, hasLimit := money(obj(w["monthlyChargeLimit"]))
	used, usedCur, hasUsed := money(obj(w["monthlyUsed"]))
	cur := "USD"
	if limitCur != "" {
		cur = limitCur
	} else if usedCur != "" {
		cur = usedCur
	}
	c := &Credits{Balance: floatPtr(left), Enabled: boolPtr(true), Unit: strings.ToLower(cur)}
	if hasUsed {
		c.Used = floatPtr(used)
	}
	if w["monthlyChargeLimitEnabled"] == true && hasLimit && limit > 0 {
		c.Limit = floatPtr(limit)
	}
	return c
}

// parseKimiLimits reads usage (the weekly quota) and limits[] (windows of
// window.duration timeUnits).
func parseKimiLimits(a *Account, m map[string]any) {
	if pct, resets, ok := kimiDetail(obj(m["usage"])); ok {
		a.Windows = append(a.Windows, Window{Kind: KindWeekly, UsedPct: pct, ResetsAt: resets, WindowSec: 7 * 86400})
	}
	for _, x := range arr(m["limits"]) {
		x := obj(x)
		pct, resets, ok := kimiDetail(obj(x["detail"]))
		if !ok {
			continue
		}
		w := obj(x["window"])
		d, _ := num(w["duration"])
		sec := int64(d * unitSeconds(str(w["timeUnit"])))
		kind := KindSession
		if sec > 86400 {
			kind = KindWeekly
		}
		a.Windows = append(a.Windows, Window{Kind: kind, UsedPct: pct, ResetsAt: resets, WindowSec: sec})
	}
	sort.SliceStable(a.Windows, func(i, j int) bool { return a.Windows[i].Kind == KindSession && a.Windows[j].Kind != KindSession })
}

// unitSeconds reads a time unit (MINUTE, TIME_UNIT_HOUR, days…).
func unitSeconds(u string) float64 {
	u = strings.ToLower(u)
	switch {
	case strings.Contains(u, "sec"):
		return 1
	case strings.Contains(u, "min"):
		return 60
	case strings.Contains(u, "hour"):
		return 3600
	case strings.Contains(u, "day"):
		return 86400
	case strings.Contains(u, "week"):
		return 7 * 86400
	}
	return 60
}
