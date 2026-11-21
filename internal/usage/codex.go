package usage

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"io/fs"
	"os"
	"path"
	"slices"
	"strings"
)

// codexHomes are the Codex homes to read: $CODEX_HOME or ~/.codex, then
// the configured ones.
func codexHomes(e *Env, extra []string) []string {
	def := path.Join(e.Home, ".codex")
	if h := e.getenv("CODEX_HOME"); h != "" {
		def = e.expand(h)
	}
	homes := []string{def}
	for _, h := range extra {
		if h = strings.TrimSpace(h); h != "" {
			if p := e.expand(h); !slices.Contains(homes, p) {
				homes = append(homes, p)
			}
		}
	}
	return homes
}

// codexAccounts reads the ChatGPT subscription's windows of each Codex
// home: auth.json's tokens, GET /backend-api/wham/usage; without an answer
// the rate limits the newest session log recorded.
func codexAccounts(ctx context.Context, e *Env, o *Options) []Account {
	var out []Account
	homes := codexHomes(e, o.CodexHomes)
	for i, home := range homes {
		label := ""
		if i > 0 {
			label = home
		}
		a := codexAccount(ctx, e, o, home, label)
		if i > 0 {
			a.Home = home
		}
		if a.Status == StatusMissing && i > 0 && len(out) > 0 {
			continue
		}
		out = append(out, a)
	}
	return out
}

// codexAccount reads one Codex home; label is its Account.Home ("" for the
// default one).
func codexAccount(ctx context.Context, e *Env, o *Options, home, label string) Account {
	a := Account{Provider: Codex, Source: "api"}
	b, err := readFile(path.Join(home, "auth.json"))
	var auth struct {
		Tokens *struct {
			IDToken     string `json:"id_token"`
			AccessToken string `json:"access_token"`
			AccountID   string `json:"account_id"`
		} `json:"tokens"`
	}
	if err != nil || json.Unmarshal(b, &auth) != nil || auth.Tokens == nil || auth.Tokens.AccessToken == "" {
		// An API key alone has no subscription windows; a log may still
		// have them.
		if log := codexFromLog(e, home); log != nil {
			return *log
		}
		a.Status = StatusMissing
		return a
	}
	t := auth.Tokens
	a.ID = t.AccountID
	if c := jwtClaims(t.IDToken); c != nil {
		a.Email = str(c["email"])
		if au := obj(c["https://api.openai.com/auth"]); au != nil {
			a.Plan = codexPlan(str(au["chatgpt_plan_type"]))
			if a.ID == "" {
				a.ID = str(au["chatgpt_account_id"])
			}
		}
	}
	if o.skips(Codex, a.ID, label) {
		return skipped(a)
	}
	if c := jwtClaims(t.AccessToken); c != nil {
		if exp := timeOf(c["exp"]); exp > 0 && exp < e.now().Unix() {
			a.Status, a.Code = StatusStale, "token_expired"
			if log := codexFromLog(e, home); log != nil {
				log.ID, log.Email, log.Plan = a.ID, a.Email, firstNonEmpty(log.Plan, a.Plan)
				log.Code = "token_expired"
				return *log
			}
			return a
		}
	}
	headers := map[string]string{"Authorization": "Bearer " + t.AccessToken}
	if t.AccountID != "" {
		headers["ChatGPT-Account-Id"] = t.AccountID
	}
	m, err := getMap(ctx, e.Client, "GET", e.URLs.CodexUsage, headers, nil)
	if err != nil {
		a = failed(a, err)
		if a.Code == "network" {
			if log := codexFromLog(e, home); log != nil {
				log.ID, log.Email, log.Plan = a.ID, a.Email, firstNonEmpty(log.Plan, a.Plan)
				return *log
			}
		}
		return a
	}
	parseCodexUsage(&a, m)
	a.Status, a.AsOf = StatusOK, e.now().Unix()
	for i := range a.Windows {
		if a.Windows[i].ResetsAt < 0 {
			a.Windows[i].ResetsAt = a.AsOf - a.Windows[i].ResetsAt
		}
	}
	return a
}

func firstNonEmpty(s ...string) string {
	for _, x := range s {
		if x != "" {
			return x
		}
	}
	return ""
}

func codexPlan(p string) string {
	if p == "" {
		return ""
	}
	return strings.ToUpper(p[:1]) + p[1:]
}

// parseCodexUsage reads plan_type, rate_limit's primary and secondary
// windows, credits and additional_rate_limits.
func parseCodexUsage(a *Account, m map[string]any) {
	if p := str(m["plan_type"]); p != "" {
		a.Plan = codexPlan(p)
	}
	a.Windows = append(a.Windows, codexWindows(obj(m["rate_limit"]), "")...)
	for _, x := range arr(m["additional_rate_limits"]) {
		x := obj(x)
		label := str(first(x, "limit_name", "name", "metered_feature", "model"))
		rl := obj(x["rate_limit"])
		if rl == nil {
			rl = x
		}
		for _, w := range codexWindows(rl, label) {
			w.Kind = KindModel
			a.Windows = append(a.Windows, w)
		}
	}
	if c := obj(m["credits"]); c != nil {
		cr := &Credits{Unit: "credits"}
		if v, ok := c["unlimited"].(bool); ok {
			cr.Unlimited = v
		}
		if v, ok := c["has_credits"].(bool); ok {
			cr.Enabled = boolPtr(v)
		}
		if v, ok := num(c["balance"]); ok {
			cr.Balance = floatPtr(v)
		}
		if cr.Balance != nil || cr.Unlimited || (cr.Enabled != nil && *cr.Enabled) {
			a.Credits = cr
		}
	}
}

// codexWindows reads primary_window and secondary_window (the API's) or
// primary and secondary (a log's rate_limits).
func codexWindows(rl map[string]any, label string) []Window {
	if rl == nil {
		return nil
	}
	var out []Window
	for _, k := range [][2]string{{"primary_window", "primary"}, {"secondary_window", "secondary"}} {
		w := obj(first(rl, k[0], k[1]))
		if w == nil {
			continue
		}
		p, ok := num(w["used_percent"])
		if !ok {
			continue
		}
		sec := int64(0)
		if v, ok := num(w["limit_window_seconds"]); ok {
			sec = int64(v)
		} else if v, ok := num(w["window_minutes"]); ok {
			sec = int64(v * 60)
		}
		kind := KindWeekly
		if sec > 0 && sec <= 86400 {
			kind = KindSession
		} else if sec == 0 && k[1] == "primary" {
			kind = KindSession
		}
		out = append(out, Window{Kind: kind, Label: label, UsedPct: clampPct(p), ResetsAt: timeOf(first(w, "reset_at", "resets_at")), WindowSec: sec})
		if out[len(out)-1].ResetsAt == 0 {
			if v, ok := num(first(w, "reset_after_seconds", "resets_in_seconds")); ok {
				out[len(out)-1].ResetsAt = -int64(v) // relative; resolved by the caller
			}
		}
	}
	return out
}

// codexFromLog is the newest rate_limits a session log of home recorded
// (a token_count event), as a stale account; nil when there is none. The
// newest log is read backwards from its end until a line has them, and
// what it said is kept (Env.Memo) while it does not change: a rollout is
// tens of MB.
func codexFromLog(e *Env, home string) *Account {
	var newest string
	var newestInfo fs.FileInfo
	for _, dir := range []string{path.Join(home, "sessions"), path.Join(home, "archived_sessions")} {
		fs.WalkDir(os.DirFS(dir), ".", func(p string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() || !strings.HasPrefix(path.Base(p), "rollout-") || !strings.HasSuffix(p, ".jsonl") {
				return nil
			}
			if info, err := d.Info(); err == nil && (newestInfo == nil || info.ModTime().After(newestInfo.ModTime())) {
				newestInfo, newest = info, path.Join(dir, p)
			}
			return nil
		})
	}
	if newest == "" {
		return nil
	}
	if a, ok := e.Memo.codexLogOf(home, newest, newestInfo.Size(), newestInfo.ModTime()); ok {
		return a
	}
	f, err := os.Open(newest)
	if err != nil {
		return nil
	}
	defer f.Close()
	var last map[string]any
	var lastTS int64
	eachLineBackward(f, newestInfo.Size(), func(line []byte) bool {
		if !bytes.Contains(line, []byte(`"rate_limits"`)) {
			return false
		}
		var d map[string]any
		if json.Unmarshal(line, &d) != nil {
			return false
		}
		rl := obj(obj(d["payload"])["rate_limits"])
		if rl == nil {
			return false
		}
		last, lastTS = rl, timeOf(d["timestamp"])
		return true
	})
	var a *Account
	if last != nil {
		a = &Account{Provider: Codex, Status: StatusStale, Code: "from_log", Source: "log", AsOf: lastTS}
		a.Windows = codexWindows(last, "")
		for i := range a.Windows {
			if a.Windows[i].ResetsAt < 0 {
				a.Windows[i].ResetsAt = lastTS - a.Windows[i].ResetsAt
			}
		}
		if p := str(last["plan_type"]); p != "" {
			a.Plan = codexPlan(p)
		}
	}
	e.Memo.keepCodexLog(home, newest, newestInfo.Size(), newestInfo.ModTime(), a)
	return a
}

// eachLineBackward calls fn with the lines of r (size bytes), the last
// first, until fn returns true; lines longer than maxLine are skipped.
func eachLineBackward(r io.ReaderAt, size int64, fn func(line []byte) bool) {
	const chunk = 256 << 10
	pos := size
	// carry is the end of a line whose start is before pos.
	var carry []byte
	long := false
	for pos > 0 {
		// Reads grow with a long line, so it is copied a few times only.
		n := min(max(int64(chunk), int64(len(carry))), pos)
		pos -= n
		b := make([]byte, n, n+int64(len(carry)))
		if _, err := r.ReadAt(b, pos); err != nil && err != io.EOF {
			return
		}
		if long {
			// Still inside a line too long to read: drop up to its start.
			i := bytes.LastIndexByte(b, '\n')
			if i < 0 {
				continue
			}
			b, long = b[:i+1], false
		} else {
			b = append(b, carry...)
		}
		for {
			i := bytes.LastIndexByte(b, '\n')
			if i < 0 {
				break
			}
			if line := bytes.TrimSpace(b[i+1:]); len(line) > 0 && len(line) <= maxLine && fn(line) {
				return
			}
			b = b[:i]
		}
		carry = b
		if len(carry) > maxLine {
			carry, long = nil, true
		}
	}
	if line := bytes.TrimSpace(carry); !long && len(line) > 0 && len(line) <= maxLine {
		fn(line)
	}
}
