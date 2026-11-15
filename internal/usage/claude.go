package usage

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"path"
	"strings"
)

// claudeCreds is the part of Claude Code's credentials Limits uses.
type claudeCreds struct {
	ClaudeAiOauth *struct {
		AccessToken      string `json:"accessToken"`
		ExpiresAt        any    `json:"expiresAt"`
		SubscriptionType string `json:"subscriptionType"`
		RateLimitTier    string `json:"rateLimitTier"`
	} `json:"claudeAiOauth"`
}

// claudeDir is Claude Code's configuration directory.
func claudeDir(e *Env) string {
	if d := e.getenv("CLAUDE_CONFIG_DIR"); d != "" {
		return e.expand(d)
	}
	return path.Join(e.Home, ".claude")
}

// claudeAccounts reads the Claude subscription's windows: the credentials
// of ~/.claude/.credentials.json (or the macOS keychain item Claude Code
// keeps them in), GET /api/oauth/usage.
func claudeAccounts(ctx context.Context, e *Env, o *Options) []Account {
	dir := claudeDir(e)
	var creds claudeCreds
	a := Account{Provider: Claude, Source: "api"}
	b, err := readFile(path.Join(dir, ".credentials.json"))
	if err != nil && o.ClaudeKeychain && e.GOOS == "darwin" && e.Keychain != nil {
		s, kerr := e.Keychain(ctx, "Claude Code-credentials")
		if kerr != nil || s == "" {
			// No item, or no one to allow the access (ssh): as if none.
			return []Account{{Provider: Claude, Status: StatusMissing, Code: "keychain"}}
		}
		b, err = []byte(s), nil
	}
	if err != nil {
		return []Account{{Provider: Claude, Status: StatusMissing}}
	}
	if json.Unmarshal(b, &creds) != nil || creds.ClaudeAiOauth == nil || creds.ClaudeAiOauth.AccessToken == "" {
		return []Account{{Provider: Claude, Status: StatusMissing, Code: "no_oauth"}}
	}
	oc := creds.ClaudeAiOauth
	a.Plan = claudePlan(oc.SubscriptionType, oc.RateLimitTier)
	a.ID, a.Email = claudeIdentity(e, dir)
	if o.skips(Claude, a.ID) {
		return []Account{skipped(a)}
	}
	if exp := timeOf(oc.ExpiresAt); exp > 0 && exp < e.now().Unix() {
		a.Status, a.Code = StatusStale, "token_expired"
		return []Account{a}
	}
	headers := map[string]string{"Authorization": "Bearer " + oc.AccessToken, "anthropic-beta": "oauth-2025-04-20"}
	if a.ID == "" {
		// No local record of the account: ask its profile (best effort).
		if p, err := getMap(ctx, e.Client, "GET", e.URLs.ClaudeProfile, headers, nil); err == nil {
			acc := obj(p["account"])
			if id := str(first(acc, "uuid", "id")); id != "" {
				a.ID = id
			}
			if a.Email == "" {
				a.Email = str(first(acc, "email", "email_address"))
			}
			if o.skips(Claude, a.ID) {
				return []Account{skipped(a)}
			}
		}
	}
	m, err := getMap(ctx, e.Client, "GET", e.URLs.ClaudeUsage, headers, nil)
	if err != nil {
		return []Account{failed(a, err)}
	}
	parseClaudeUsage(&a, m)
	a.Status, a.AsOf = StatusOK, e.now().Unix()
	return []Account{a}
}

// claudeIdentity is the signed-in account as Claude Code records it in
// ~/.claude.json (oauthAccount).
func claudeIdentity(e *Env, dir string) (id, email string) {
	files := []string{path.Join(dir, ".claude.json"), path.Join(e.Home, ".claude.json")}
	for _, f := range files {
		b, err := readFile(f)
		if err != nil {
			continue
		}
		var v struct {
			OAuthAccount struct {
				AccountUUID  string `json:"accountUuid"`
				EmailAddress string `json:"emailAddress"`
			} `json:"oauthAccount"`
		}
		if json.Unmarshal(b, &v) == nil && (v.OAuthAccount.AccountUUID != "" || v.OAuthAccount.EmailAddress != "") {
			return v.OAuthAccount.AccountUUID, v.OAuthAccount.EmailAddress
		}
	}
	return "", ""
}

func claudePlan(sub, tier string) string {
	sub = strings.TrimSpace(sub)
	if sub == "" {
		return ""
	}
	plan := strings.ToUpper(sub[:1]) + sub[1:]
	t := strings.ToLower(tier)
	switch {
	case strings.Contains(t, "20x"):
		plan += " 20x"
	case strings.Contains(t, "5x"):
		plan += " 5x"
	}
	return plan
}

// parseClaudeUsage reads five_hour, seven_day, seven_day_<model> and
// extra_usage.
func parseClaudeUsage(a *Account, m map[string]any) {
	add := func(key, kind, label string, sec int64) {
		w := obj(m[key])
		if w == nil {
			return
		}
		p, ok := num(w["utilization"])
		if !ok {
			return
		}
		a.Windows = append(a.Windows, Window{Kind: kind, Label: label, UsedPct: clampPct(p), ResetsAt: timeOf(w["resets_at"]), WindowSec: sec})
	}
	add("five_hour", KindSession, "", 5*3600)
	add("seven_day", KindWeekly, "", 7*86400)
	add("seven_day_opus", KindModel, "Opus", 7*86400)
	add("seven_day_sonnet", KindModel, "Sonnet", 7*86400)
	if x := obj(m["extra_usage"]); x != nil {
		c := &Credits{Unit: "usd"}
		if en, ok := x["is_enabled"].(bool); ok {
			c.Enabled = boolPtr(en)
		}
		// Amounts are in cents.
		if v, ok := num(x["monthly_limit"]); ok {
			c.Limit = floatPtr(v / 100)
		}
		if v, ok := num(x["used_credits"]); ok {
			c.Used = floatPtr(v / 100)
		}
		if c.Enabled != nil || c.Limit != nil || c.Used != nil {
			a.Credits = c
		}
		if p, ok := num(x["utilization"]); ok && c.Enabled != nil && *c.Enabled {
			a.Windows = append(a.Windows, Window{Kind: KindMonthly, Label: "Extra", UsedPct: clampPct(p)})
		}
	}
}

// jwtClaims decodes a JWT's payload without checking it (only to read the
// account it names on the machine it was issued to).
func jwtClaims(tok string) map[string]any {
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		return nil
	}
	b, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return nil
	}
	var m map[string]any
	if json.Unmarshal(b, &m) != nil {
		return nil
	}
	return m
}
