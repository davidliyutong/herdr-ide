package usage

import (
	"context"
	"errors"
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

// parseKimiUsage reads usage (the weekly quota) and limits[] (windows of
// window.duration timeUnits).
func parseKimiUsage(a *Account, m map[string]any) {
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
