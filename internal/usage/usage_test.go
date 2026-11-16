package usage

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

var testNow = time.Date(2026, 11, 16, 12, 0, 0, 0, time.UTC)

// fakeAPI answers the providers' endpoints from a table of path → reply
// and records the headers of each request.
type fakeAPI struct {
	*httptest.Server
	mu      sync.Mutex
	replies map[string]func(w http.ResponseWriter, r *http.Request)
	headers map[string]http.Header
}

func newFakeAPI(t *testing.T) *fakeAPI {
	f := &fakeAPI{replies: map[string]func(http.ResponseWriter, *http.Request){}, headers: map[string]http.Header{}}
	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.headers[r.URL.Path] = r.Header.Clone()
		h := f.replies[r.URL.Path]
		f.mu.Unlock()
		if h == nil {
			http.NotFound(w, r)
			return
		}
		h(w, r)
	}))
	t.Cleanup(f.Close)
	return f
}

func (f *fakeAPI) json(path string, body string) {
	f.replies[path] = func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(body))
	}
}

func (f *fakeAPI) status(path string, code int, headers map[string]string) {
	f.replies[path] = func(w http.ResponseWriter, r *http.Request) {
		for k, v := range headers {
			w.Header().Set(k, v)
		}
		w.WriteHeader(code)
	}
}

func (f *fakeAPI) header(path, key string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if h := f.headers[path]; h != nil {
		return h.Get(key)
	}
	return ""
}

func (f *fakeAPI) asked(path string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	_, ok := f.headers[path]
	return ok
}

func testEnv(t *testing.T, api *fakeAPI) *Env {
	home := t.TempDir()
	e := &Env{
		Home: home, Base: filepath.Join(home, ".app"),
		Getenv: func(string) string { return "" }, Environ: func() []string { return nil },
		Client: &http.Client{Timeout: 5 * time.Second}, Now: func() time.Time { return testNow }, GOOS: "linux",
		Command: func(context.Context, []string, string, ...string) ([]byte, error) {
			return nil, errors.New("no commands in tests")
		},
		LookPath: func(string) (string, error) { return "", errors.New("none") },
		UID:      501, ProcRoot: filepath.Join(home, "proc"),
	}
	if api != nil {
		u := api.URL
		e.URLs = URLs{
			ClaudeUsage: u + "/api/oauth/usage", ClaudeProfile: u + "/api/oauth/profile",
			CodexUsage:  u + "/backend-api/wham/usage",
			GrokBilling: u + "/v1/billing?format=credits", GrokSettings: u + "/v1/settings",
			KimiUsage: u + "/coding/v1/usages", DeepSeekBalance: u + "/user/balance",
		}
	}
	return e
}

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func jwt(claims map[string]any) string {
	b, _ := json.Marshal(claims)
	enc := base64.RawURLEncoding.EncodeToString
	return enc([]byte(`{"alg":"none"}`)) + "." + enc(b) + ".sig"
}

func one(t *testing.T, accs []Account) Account {
	t.Helper()
	if len(accs) != 1 {
		t.Fatalf("accounts %+v", accs)
	}
	return accs[0]
}

const claudeUsageJSON = `{
  "five_hour": {"utilization": 42.5, "resets_at": "2026-11-16T15:00:00Z"},
  "seven_day": {"utilization": 61, "resets_at": "2026-11-20T00:00:00+00:00"},
  "seven_day_opus": {"utilization": 10, "resets_at": null},
  "seven_day_sonnet": null,
  "extra_usage": {"is_enabled": true, "monthly_limit": 5000, "used_credits": 1250, "utilization": 25}
}`

func TestClaude(t *testing.T) {
	api := newFakeAPI(t)
	api.json("/api/oauth/usage", claudeUsageJSON)
	e := testEnv(t, api)
	exp := testNow.Add(time.Hour).UnixMilli()
	write(t, filepath.Join(e.Home, ".claude/.credentials.json"),
		`{"claudeAiOauth":{"accessToken":"sk-ant-oat","refreshToken":"r","expiresAt":`+itoa(exp)+`,"subscriptionType":"max","rateLimitTier":"default_claude_max_20x"}}`)
	write(t, filepath.Join(e.Home, ".claude.json"), `{"oauthAccount":{"accountUuid":"acc-1","emailAddress":"a@example.com"}}`)
	a := one(t, Limits(context.Background(), e, Options{Providers: []string{Claude}}))
	if a.Status != StatusOK || a.ID != "acc-1" || a.Email != "a@example.com" || a.Plan != "Max 20x" {
		t.Fatalf("account %+v", a)
	}
	if got := api.header("/api/oauth/usage", "Authorization"); got != "Bearer sk-ant-oat" {
		t.Errorf("authorization %q", got)
	}
	if got := api.header("/api/oauth/usage", "anthropic-beta"); got != "oauth-2025-04-20" {
		t.Errorf("beta header %q", got)
	}
	if len(a.Windows) != 4 {
		t.Fatalf("windows %+v", a.Windows)
	}
	w := a.Windows[0]
	if w.Kind != KindSession || w.UsedPct != 42.5 || w.ResetsAt != time.Date(2026, 11, 16, 15, 0, 0, 0, time.UTC).Unix() || w.WindowSec != 18000 {
		t.Errorf("session %+v", w)
	}
	if a.Windows[1].Kind != KindWeekly || a.Windows[2].Label != "Opus" || a.Windows[2].ResetsAt != 0 || a.Windows[3].Kind != KindMonthly {
		t.Errorf("windows %+v", a.Windows)
	}
	if a.Credits == nil || *a.Credits.Limit != 50 || *a.Credits.Used != 12.5 || !*a.Credits.Enabled {
		t.Errorf("credits %+v", a.Credits)
	}
	// Tokens never come back.
	b, _ := json.Marshal(a)
	if strings.Contains(string(b), "sk-ant") {
		t.Errorf("token in %s", b)
	}

	// The core has the account already: nothing is asked.
	api.headers = map[string]http.Header{}
	a = one(t, Limits(context.Background(), e, Options{Providers: []string{Claude}, Skip: []string{"claude:acc-1"}}))
	if a.Status != StatusSkipped || api.asked("/api/oauth/usage") {
		t.Errorf("skip: %+v", a)
	}
}

func itoa(n int64) string { b, _ := json.Marshal(n); return string(b) }

func TestClaudeStaleUnauthLimited(t *testing.T) {
	api := newFakeAPI(t)
	e := testEnv(t, api)
	creds := filepath.Join(e.Home, ".claude/.credentials.json")
	// Expired: stale, and the token is not even sent.
	write(t, creds, `{"claudeAiOauth":{"accessToken":"t","expiresAt":`+itoa(testNow.Add(-time.Minute).UnixMilli())+`}}`)
	a := one(t, Limits(context.Background(), e, Options{Providers: []string{Claude}}))
	if a.Status != StatusStale || a.Code != "token_expired" || api.asked("/api/oauth/usage") {
		t.Fatalf("expired %+v", a)
	}
	write(t, creds, `{"claudeAiOauth":{"accessToken":"t","expiresAt":`+itoa(testNow.Add(time.Hour).UnixMilli())+`}}`)
	api.status("/api/oauth/usage", 401, nil)
	if a = one(t, Limits(context.Background(), e, Options{Providers: []string{Claude}})); a.Status != StatusUnauth {
		t.Errorf("401: %+v", a)
	}
	api.status("/api/oauth/usage", 429, map[string]string{"Retry-After": "120"})
	if a = one(t, Limits(context.Background(), e, Options{Providers: []string{Claude}})); a.Status != StatusError || a.Code != "rate_limited" || a.RetryAfter != 120 {
		t.Errorf("429: %+v", a)
	}
	api.status("/api/oauth/usage", 500, nil)
	if a = one(t, Limits(context.Background(), e, Options{Providers: []string{Claude}})); a.Code != "http_500" {
		t.Errorf("500: %+v", a)
	}
	// No credentials at all.
	os.Remove(creds)
	if a = one(t, Limits(context.Background(), e, Options{Providers: []string{Claude}})); a.Status != StatusMissing {
		t.Errorf("missing: %+v", a)
	}
}

func TestClaudeKeychain(t *testing.T) {
	api := newFakeAPI(t)
	api.json("/api/oauth/usage", claudeUsageJSON)
	api.json("/api/oauth/profile", `{"account":{"uuid":"acc-k","email":"k@example.com"}}`)
	e := testEnv(t, api)
	e.GOOS = "darwin"
	asked := 0
	e.Keychain = func(_ context.Context, service string) (string, error) {
		asked++
		if service != "Claude Code-credentials" {
			t.Errorf("service %q", service)
		}
		return `{"claudeAiOauth":{"accessToken":"kc","expiresAt":` + itoa(testNow.Add(time.Hour).UnixMilli()) + `,"subscriptionType":"pro"}}`, nil
	}
	// Off: the keychain is not read.
	if a := one(t, Limits(context.Background(), e, Options{Providers: []string{Claude}})); a.Status != StatusMissing || asked != 0 {
		t.Fatalf("keychain off: %+v", a)
	}
	a := one(t, Limits(context.Background(), e, Options{Providers: []string{Claude}, ClaudeKeychain: true}))
	if a.Status != StatusOK || a.ID != "acc-k" || a.Plan != "Pro" || asked != 1 {
		t.Fatalf("keychain: %+v", a)
	}
	e.Keychain = func(context.Context, string) (string, error) {
		return "", errors.New("user interaction is not allowed")
	}
	if a := one(t, Limits(context.Background(), e, Options{Providers: []string{Claude}, ClaudeKeychain: true})); a.Status != StatusMissing || a.Code != "keychain" {
		t.Errorf("keychain refused: %+v", a)
	}
}

const codexUsageJSON = `{
  "plan_type": "pro",
  "rate_limit": {
    "allowed": true,
    "primary_window": {"used_percent": 12, "limit_window_seconds": 18000, "reset_at": 1795000000},
    "secondary_window": {"used_percent": 70.5, "limit_window_seconds": 604800, "reset_after_seconds": 3600}
  },
  "credits": {"has_credits": true, "unlimited": false, "balance": "37.5"},
  "additional_rate_limits": [
    {"limit_name": "GPT-5.3-Codex-Spark", "rate_limit": {"primary_window": {"used_percent": 3, "limit_window_seconds": 18000, "reset_at": 1795000100}}}
  ]
}`

func codexAuth(t *testing.T, home string, exp time.Time) {
	idTok := jwt(map[string]any{"email": "c@example.com", "https://api.openai.com/auth": map[string]any{"chatgpt_plan_type": "plus"}})
	acc := jwt(map[string]any{"exp": exp.Unix()})
	write(t, filepath.Join(home, "auth.json"), `{"OPENAI_API_KEY":null,"tokens":{"id_token":"`+idTok+`","access_token":"`+acc+`","refresh_token":"r","account_id":"org-acc"}}`)
}

const codexRollout = `{"timestamp":"2026-11-15T10:00:00.000Z","type":"session_meta","payload":{"cwd":"/home/u/proj-a"}}
{"timestamp":"2026-11-15T10:00:01.000Z","type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{"primary":{"used_percent":20,"window_minutes":300,"resets_in_seconds":600},"secondary":{"used_percent":50,"window_minutes":10080,"resets_at":1795100000}}}}
`

func TestCodex(t *testing.T) {
	api := newFakeAPI(t)
	api.json("/backend-api/wham/usage", codexUsageJSON)
	e := testEnv(t, api)
	codexAuth(t, filepath.Join(e.Home, ".codex"), testNow.Add(time.Hour))
	a := one(t, Limits(context.Background(), e, Options{Providers: []string{Codex}}))
	if a.Status != StatusOK || a.ID != "org-acc" || a.Email != "c@example.com" || a.Plan != "Pro" {
		t.Fatalf("account %+v", a)
	}
	if got := api.header("/backend-api/wham/usage", "ChatGPT-Account-Id"); got != "org-acc" {
		t.Errorf("account header %q", got)
	}
	if len(a.Windows) != 3 || a.Windows[0].Kind != KindSession || a.Windows[0].ResetsAt != 1795000000 ||
		a.Windows[1].Kind != KindWeekly || a.Windows[1].ResetsAt != testNow.Unix()+3600 ||
		a.Windows[2].Kind != KindModel || a.Windows[2].Label != "GPT-5.3-Codex-Spark" {
		t.Errorf("windows %+v", a.Windows)
	}
	if a.Credits == nil || *a.Credits.Balance != 37.5 {
		t.Errorf("credits %+v", a.Credits)
	}
}

func TestCodexOfflineFallback(t *testing.T) {
	api := newFakeAPI(t)
	e := testEnv(t, api)
	home := filepath.Join(e.Home, ".codex")
	write(t, filepath.Join(home, "sessions/2026/11/15/rollout-a.jsonl"), codexRollout)
	// No answer from the API (network): the newest log's rate limits.
	codexAuth(t, home, testNow.Add(time.Hour))
	e.URLs.CodexUsage = "http://127.0.0.1:1/unreachable"
	a := one(t, Limits(context.Background(), e, Options{Providers: []string{Codex}}))
	if a.Status != StatusStale || a.Code != "from_log" || a.Source != "log" || a.ID != "org-acc" {
		t.Fatalf("fallback %+v", a)
	}
	logTime := time.Date(2026, 11, 15, 10, 0, 1, 0, time.UTC).Unix()
	if len(a.Windows) != 2 || a.Windows[0].UsedPct != 20 || a.Windows[0].WindowSec != 18000 || a.Windows[0].ResetsAt != logTime+600 ||
		a.Windows[1].ResetsAt != 1795100000 || a.Windows[1].Kind != KindWeekly || a.AsOf != logTime {
		t.Errorf("windows %+v", a)
	}
	// An expired token: stale, numbers from the log.
	codexAuth(t, home, testNow.Add(-time.Hour))
	a = one(t, Limits(context.Background(), e, Options{Providers: []string{Codex}}))
	if a.Status != StatusStale || a.Code != "token_expired" || len(a.Windows) != 2 {
		t.Errorf("expired %+v", a)
	}
	// Another home configured, without credentials: left out.
	accs := Limits(context.Background(), e, Options{Providers: []string{Codex}, CodexHomes: []string{"~/other-codex"}})
	if len(accs) != 1 {
		t.Errorf("homes %+v", accs)
	}
}

func TestGrok(t *testing.T) {
	api := newFakeAPI(t)
	api.json("/v1/billing", `{"config":{"creditUsagePercent":33.3,"currentPeriod":{"start":"2026-11-01T00:00:00Z","end":"2026-12-01T00:00:00Z"},
	  "onDemandUsed":{"val":"3"},"onDemandCap":{"val":10},"productUsage":[{"product":"grok-code","usagePercent":12}]}}`)
	api.json("/v1/settings", `{"subscription_tier_display":"SuperGrok Heavy"}`)
	e := testEnv(t, api)
	write(t, filepath.Join(e.Home, ".grok/auth.json"), `{
	  "https://other.example::x": {"key": "other", "email": "o@example.com"},
	  "https://auth.x.ai::grok-cli": {"key": "xai-key", "expires_at": "2027-01-01T00:00:00Z", "email": "g@example.com", "user_id": "u-9"}}`)
	a := one(t, Limits(context.Background(), e, Options{Providers: []string{Grok}}))
	if a.Status != StatusOK || a.ID != "u-9" || a.Plan != "SuperGrok Heavy" {
		t.Fatalf("account %+v", a)
	}
	if api.header("/v1/billing", "Authorization") != "Bearer xai-key" || api.header("/v1/billing", "X-XAI-Token-Auth") != "xai-grok-cli" {
		t.Errorf("headers %v", api.headers["/v1/billing"])
	}
	if len(a.Windows) != 2 || a.Windows[0].UsedPct != 33.3 || a.Windows[0].WindowSec != 30*86400 || a.Windows[1].Label != "grok-code" {
		t.Errorf("windows %+v", a.Windows)
	}
	if *a.Credits.Used != 3 || *a.Credits.Limit != 10 {
		t.Errorf("credits %+v", a.Credits)
	}
	// An entry without a key lends nothing to the next one.
	write(t, filepath.Join(e.Home, ".grok/auth.json"), `{
	  "https://auth.x.ai::old": {"expires_at": "2020-01-01T00:00:00Z", "email": "old@example.com", "user_id": "u-old"},
	  "https://other.example::x": {"key": "other-key"}}`)
	if a := one(t, Limits(context.Background(), e, Options{Providers: []string{Grok}})); a.Status != StatusOK || a.ID != "" || a.Email != "" {
		t.Errorf("entry without a key bled into the next: %+v", a)
	}
	// Without the percentage: on-demand used over its cap.
	b := Account{}
	parseGrokBilling(&b, map[string]any{"config": map[string]any{"onDemandUsed": map[string]any{"val": 5.0}, "onDemandCap": map[string]any{"val": 20.0}}})
	if len(b.Windows) != 1 || b.Windows[0].UsedPct != 25 {
		t.Errorf("fallback %+v", b.Windows)
	}
}

func TestKimiStringNumbers(t *testing.T) {
	api := newFakeAPI(t)
	api.json("/coding/v1/usages", `{"usage":{"limit":"1000","used":"250","remaining":"750","resetTime":"2026-11-20T00:00:00Z"},
	  "limits":[{"window":{"duration":300,"timeUnit":"TIME_UNIT_MINUTE"},"detail":{"limit":"100","remaining":"40","resetTime":"2026-11-16T14:00:00Z"}}]}`)
	e := testEnv(t, api)
	write(t, filepath.Join(e.Home, ".kimi-code/credentials/kimi-code.json"),
		`{"access_token":"`+jwt(map[string]any{"user_id": "k-1"})+`","expires_at":`+itoa(testNow.Add(time.Hour).Unix())+`}`)
	a := one(t, Limits(context.Background(), e, Options{Providers: []string{Kimi}}))
	if a.Status != StatusOK || a.ID != "k-1" {
		t.Fatalf("account %+v", a)
	}
	if len(a.Windows) != 2 || a.Windows[0].Kind != KindSession || a.Windows[0].UsedPct != 60 || a.Windows[0].WindowSec != 18000 ||
		a.Windows[1].Kind != KindWeekly || a.Windows[1].UsedPct != 25 {
		t.Errorf("windows %+v", a.Windows)
	}
	write(t, filepath.Join(e.Home, ".kimi-code/credentials/kimi-code.json"), `{"access_token":"x","expires_at":1}`)
	if a = one(t, Limits(context.Background(), e, Options{Providers: []string{Kimi}})); a.Status != StatusStale {
		t.Errorf("expired %+v", a)
	}
}

// Kimi Code 2.2.0's shape: usages with used_ratio (a number or a string)
// and reset_time, the month's code part labelled, and the booster wallet.
func TestKimiUsagesShape(t *testing.T) {
	api := newFakeAPI(t)
	api.json("/coding/v1/usages", `{"usages":{
	    "limit_5h":{"used_ratio":0.42,"reset_time":"2026-11-16T15:00:00Z"},
	    "limit_7d":{"used_ratio":"0.1","reset_time":"2026-11-20T00:00:00Z"},
	    "limit_month_total":{"used_ratio":0.6,"reset_time":"2026-12-01T00:00:00Z"},
	    "limit_month_code":{"used_ratio":0.25,"reset_time":"2026-12-01T00:00:00Z"},
	    "limit_unknown":{"used_ratio":0.9}},
	  "boosterWallet":{"balance":{"type":"BOOSTER","amount":"5000000000","amountLeft":1234000000},
	    "monthlyChargeLimitEnabled":true,"monthlyChargeLimit":{"priceInCents":5000,"currency":"CNY"},"monthlyUsed":{"priceInCents":"300","currency":"CNY"}}}`)
	e := testEnv(t, api)
	write(t, filepath.Join(e.Home, ".kimi-code/credentials/kimi-code.json"),
		`{"access_token":"`+jwt(map[string]any{"user_id": "k-1"})+`","expires_at":`+itoa(testNow.Add(time.Hour).Unix())+`}`)
	a := one(t, Limits(context.Background(), e, Options{Providers: []string{Kimi}}))
	want := []Window{
		{Kind: KindSession, UsedPct: 42, ResetsAt: time.Date(2026, 11, 16, 15, 0, 0, 0, time.UTC).Unix(), WindowSec: 18000},
		{Kind: KindWeekly, UsedPct: 10, ResetsAt: time.Date(2026, 11, 20, 0, 0, 0, 0, time.UTC).Unix(), WindowSec: 604800},
		{Kind: KindMonthly, UsedPct: 60, ResetsAt: time.Date(2026, 12, 1, 0, 0, 0, 0, time.UTC).Unix(), WindowSec: 30 * 86400},
		{Kind: KindMonthly, Label: "Code", UsedPct: 25, ResetsAt: time.Date(2026, 12, 1, 0, 0, 0, 0, time.UTC).Unix(), WindowSec: 30 * 86400},
	}
	if a.Status != StatusOK || !reflect.DeepEqual(a.Windows, want) {
		t.Fatalf("windows %+v", a.Windows)
	}
	c := a.Credits
	if c == nil || *c.Balance != 12.34 || *c.Used != 3 || *c.Limit != 50 || c.Unit != "cny" || !*c.Enabled {
		t.Errorf("wallet %+v", c)
	}
}

func TestKimiShapesAndWallets(t *testing.T) {
	older := `"usage":{"limit":"100","used":"30","resetTime":"2026-11-20T00:00:00Z"},
	  "limits":[{"window":{"duration":300,"timeUnit":"TIME_UNIT_MINUTE"},"detail":{"limit":"100","remaining":"40"}}]`
	newer2 := `"usages":{"limit_5h":{"used_ratio":0.5},"limit_7d":{"used_ratio":0.3}}`
	newer4 := `"usages":{"limit_5h":{"used_ratio":0.5},"limit_7d":{"used_ratio":0.3},"limit_month_total":{"used_ratio":0.2},"limit_month_code":{"used_ratio":0.1}}`
	newer1 := `"usages":{"limit_7d":{"used_ratio":0.3}}`
	for _, c := range []struct {
		name, body string
		kinds      []string
	}{
		{"older only", "{" + older + "}", []string{"session", "weekly"}},
		{"both, the newer richer", "{" + older + "," + newer4 + "}", []string{"session", "weekly", "monthly", "monthly"}},
		{"both, the older richer", "{" + older + "," + newer1 + "}", []string{"session", "weekly"}},
		{"both, as rich: the newer", "{" + older + "," + newer2 + "}", []string{"session", "weekly"}},
		{"neither", `{"usages":{},"limits":[]}`, nil},
	} {
		var a Account
		var m map[string]any
		if err := json.Unmarshal([]byte(c.body), &m); err != nil {
			t.Fatal(c.name, err)
		}
		parseKimiUsage(&a, m)
		var kinds []string
		for _, w := range a.Windows {
			kinds = append(kinds, w.Kind)
		}
		if !reflect.DeepEqual(kinds, c.kinds) {
			t.Errorf("%s: %v", c.name, kinds)
		}
		if c.name == "both, as rich: the newer" && a.Windows[1].UsedPct != 30 {
			t.Errorf("%s: %+v", c.name, a.Windows)
		}
	}
	for _, c := range []struct {
		name, wallet string
		want         *Credits
	}{
		{"none", `null`, nil},
		{"not a booster", `{"balance":{"type":"GIFT","amount":100}}`, nil},
		{"empty", `{"balance":{"type":"BOOSTER","amount":0}}`, nil},
		{"no limit, a cent at least, dollars", `{"balance":{"type":"BOOSTER","amount":1000000,"amountLeft":400000},"monthlyChargeLimitEnabled":false,"monthlyChargeLimit":{"priceInCents":900}}`,
			&Credits{Balance: floatPtr(0.01), Enabled: boolPtr(true), Unit: "usd"}},
	} {
		var m map[string]any
		json.Unmarshal([]byte(`{"boosterWallet":`+c.wallet+`}`), &m)
		var a Account
		parseKimiUsage(&a, m)
		if !reflect.DeepEqual(a.Credits, c.want) {
			t.Errorf("%s: %+v", c.name, a.Credits)
		}
	}
}

func TestDeepSeek(t *testing.T) {
	api := newFakeAPI(t)
	api.json("/user/balance", `{"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"110.00","granted_balance":"10.00","topped_up_balance":"100.00"}]}`)
	e := testEnv(t, api)
	if a := one(t, Limits(context.Background(), e, Options{Providers: []string{DeepSeek}})); a.Status != StatusMissing {
		t.Fatalf("no key: %+v", a)
	}
	// Claude Code pointed at DeepSeek.
	write(t, filepath.Join(e.Home, ".claude/settings.json"), `{"env":{"ANTHROPIC_BASE_URL":"https://api.deepseek.com/anthropic","ANTHROPIC_AUTH_TOKEN":"sk-claude-ds"}}`)
	a := one(t, Limits(context.Background(), e, Options{Providers: []string{DeepSeek}}))
	if a.Status != StatusOK || api.header("/user/balance", "Authorization") != "Bearer sk-claude-ds" || a.ID != HashID("sk-claude-ds") {
		t.Fatalf("settings key: %+v", a)
	}
	if len(a.Balances) != 1 || a.Balances[0].Total != 110 || a.Balances[0].Currency != "CNY" || !*a.Available {
		t.Errorf("balance %+v", a)
	}
	if b, _ := json.Marshal(a); strings.Contains(string(b), "sk-claude-ds") {
		t.Errorf("key in %s", b)
	}
	// The environment's key first.
	e.Getenv = func(k string) string {
		if k == "DEEPSEEK_API_KEY" {
			return "sk-env"
		}
		return ""
	}
	one(t, Limits(context.Background(), e, Options{Providers: []string{DeepSeek}}))
	if api.header("/user/balance", "Authorization") != "Bearer sk-env" {
		t.Errorf("env key not used")
	}
	// The key file the UI writes.
	e.Getenv = func(string) string { return "" }
	os.Remove(filepath.Join(e.Home, ".claude/settings.json"))
	if err := SetDeepSeekKey(e.Base, "sk-file"); err != nil {
		t.Fatal(err)
	}
	st, _ := os.Stat(filepath.Join(e.Base, DeepSeekKeyFile))
	dst, _ := os.Stat(filepath.Join(e.Base, "usage"))
	if st.Mode().Perm() != 0o600 || dst.Mode().Perm() != 0o700 {
		t.Errorf("modes %v %v", st.Mode(), dst.Mode())
	}
	one(t, Limits(context.Background(), e, Options{Providers: []string{DeepSeek}}))
	if api.header("/user/balance", "Authorization") != "Bearer sk-file" {
		t.Errorf("file key not used")
	}
	// The key saved in the panel wins over the environment's.
	e.Getenv = func(k string) string {
		if k == "DEEPSEEK_API_KEY" {
			return "sk-env"
		}
		return ""
	}
	one(t, Limits(context.Background(), e, Options{Providers: []string{DeepSeek}}))
	if api.header("/user/balance", "Authorization") != "Bearer sk-file" {
		t.Errorf("the environment's key won over the saved one")
	}
	if err := SetDeepSeekKey(e.Base, "bad key\n"); !errors.Is(err, ErrBadKey) {
		t.Errorf("bad key: %v", err)
	}
	if err := SetDeepSeekKey(e.Base, ""); err != nil {
		t.Errorf("remove: %v", err)
	}
	if _, err := os.Stat(filepath.Join(e.Base, DeepSeekKeyFile)); !os.IsNotExist(err) {
		t.Errorf("key file left: %v", err)
	}
}

func TestAntigravityLanguageServer(t *testing.T) {
	ls := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/exa.language_server_pb.LanguageServerService/GetUserStatus" || r.Header.Get("X-Codeium-Csrf-Token") != "tok-1" ||
			r.Header.Get("Connect-Protocol-Version") != "1" || r.Method != "POST" {
			w.WriteHeader(403)
			return
		}
		w.Write([]byte(`{"userStatus":{"email":"ag@example.com","planStatus":{"planInfo":{"planName":"Pro"}},
		  "cascadeModelConfigData":{"clientModelConfigs":[
		    {"label":"Gemini 3 Pro","quotaInfo":{"remainingFraction":0.25,"resetTime":"2026-11-16T17:00:00Z"}},
		    {"label":"Claude Sonnet","quotaInfo":{"resetTime":"2026-11-16T18:00:00Z"}},
		    {"label":"No quota"}]}}}`))
	}))
	defer ls.Close()
	port := ls.Listener.Addr().(*net.TCPAddr).Port
	e := testEnv(t, nil)
	e.GOOS = "darwin"
	e.Command = func(_ context.Context, _ []string, name string, args ...string) ([]byte, error) {
		switch filepath.Base(name) {
		case "ps":
			if strings.Join(args, " ") != "-ax -o uid=,pid=,command=" {
				t.Errorf("ps %q", args)
			}
			return []byte("  501    12 /usr/bin/zsh\n  502   300 /Applications/Antigravity.app/Contents/Resources/bin/language_server_macos_arm --csrf_token other-user\n  501   345 /Applications/Antigravity.app/Contents/Resources/bin/language_server_macos_arm --csrf_token tok-1 --random_port\n"), nil
		case "lsof":
			if strings.Join(args, " ") != "-nP -a -p 345 -iTCP -sTCP:LISTEN -Fn" {
				t.Errorf("lsof %q", args)
			}
			return []byte("p345\nf20\nn127.0.0.1:" + itoa(int64(port)) + "\nf21\nn10.0.0.2:9999\n"), nil
		}
		return nil, errors.New("unexpected " + name)
	}
	e.LocalClient = func(p int) *http.Client {
		if p != port {
			t.Errorf("port %d", p)
		}
		return localClient(p)
	}
	a := one(t, Limits(context.Background(), e, Options{Providers: []string{Antigravity}}))
	if a.Status != StatusOK || a.Email != "ag@example.com" || a.Plan != "Pro" || a.Source != "ls" || a.ID != HashID("ag@example.com") {
		t.Fatalf("account %+v", a)
	}
	if len(a.Windows) != 2 || a.Windows[0].UsedPct != 75 || a.Windows[1].UsedPct != 100 || a.Windows[1].Label != "Claude Sonnet" {
		t.Errorf("windows %+v", a.Windows)
	}
}

func TestAntigravityAgyFallback(t *testing.T) {
	e := testEnv(t, nil)
	var gotEnv []string
	e.LookPath = func(name string) (string, error) { return "/opt/bin/agy", nil }
	e.Command = func(ctx context.Context, env []string, name string, args ...string) ([]byte, error) {
		if filepath.Base(name) == "ps" {
			return []byte(""), nil
		}
		if name != "/opt/bin/agy" || strings.Join(args, " ") != "-p /usage --output-format json" {
			t.Errorf("ran %s %q", name, args)
		}
		if dl, ok := ctx.Deadline(); !ok || time.Until(dl) > AgyTimeout {
			t.Errorf("agy without its timeout")
		}
		gotEnv = env
		return []byte(`Loading…` + "\n" + `{"email":"ag@example.com","models":[{"model":"Gemini 3 Flash","remainingFraction":0.9,"resetTime":"2026-11-16T17:00:00Z"}]}`), nil
	}
	a := one(t, Limits(context.Background(), e, Options{Providers: []string{Antigravity}}))
	if a.Status != StatusOK || a.Source != "cli" || len(a.Windows) != 1 || a.Windows[0].UsedPct != 10 || a.Email != "ag@example.com" {
		t.Fatalf("account %+v", a)
	}
	found := false
	for _, kv := range gotEnv {
		found = found || kv == "AGY_CLI_DISABLE_AUTO_UPDATE=true"
	}
	if !found {
		t.Errorf("env %q", gotEnv)
	}
	// Nothing runs and there is no agy: missing.
	e.LookPath = func(string) (string, error) { return "", errors.New("none") }
	if a := one(t, Limits(context.Background(), e, Options{Providers: []string{Antigravity}})); a.Status != StatusMissing {
		t.Errorf("missing %+v", a)
	}
}

func TestProcPorts(t *testing.T) {
	root := t.TempDir()
	fd := filepath.Join(root, "77", "fd")
	os.MkdirAll(fd, 0o700)
	os.Symlink("socket:[1111]", filepath.Join(fd, "3"))
	os.Symlink("socket:[2222]", filepath.Join(fd, "4"))
	os.Symlink("/dev/null", filepath.Join(fd, "5"))
	write(t, filepath.Join(root, "net/tcp"), `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:A1B2 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1111 1 0000000000000000 100 0 0 10 0
   1: 0100007F:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 3333 1 0000000000000000 100 0 0 10 0
   2: 0200000A:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 2222 1 0000000000000000 100 0 0 10 0
`)
	ports := procPorts(root, 77)
	if len(ports) != 1 || ports[0] != 0xA1B2 {
		t.Errorf("ports %v", ports)
	}
}

func TestRetryAfter(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for h, want := range map[string]int64{"30": 30, "": 60, "junk": 60, "999999": 86400, now.Add(90 * time.Second).Format(http.TimeFormat): 90} {
		if got := retryAfter(h, now); got != want {
			t.Errorf("Retry-After %q: %d, want %d", h, got, want)
		}
	}
}

func TestProxyFromEnvironment(t *testing.T) {
	tr := NewClient().Transport.(*http.Transport)
	if tr.Proxy == nil || NewClient().Timeout != Timeout {
		t.Fatal("client must honor HTTPS_PROXY and time out")
	}
}

// The language server's client reaches 127.0.0.1 only, whatever the URL
// names, and never through a proxy.
func TestLocalClientStaysOnLoopback(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("local")) }))
	defer srv.Close()
	port := srv.Listener.Addr().(*net.TCPAddr).Port
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:1")
	c := localClient(port)
	res, err := c.Get("http://example.invalid/anything")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if tr := c.Transport.(*http.Transport); tr.Proxy != nil {
		t.Error("proxy set")
	}
}

// agy 1.5's output: a table in response, and groups of buckets in command.data.
func TestParseAgyGroups(t *testing.T) {
	out := []byte(`{"conversation_id":"","status":"SUCCESS","response":"Gemini Models\tWeekly Limit Remaining\t85%\n","command":{"name":"usage","data":{"groups":[` +
		`{"name":"Gemini Models","buckets":[{"id":"gemini-weekly","name":"Weekly Limit Remaining","window":"weekly","remaining_fraction":0.85,"reset_time":"2026-11-21T06:22:44Z"},` +
		`{"id":"gemini-5h","name":"Five Hour Limit Remaining","window":"5h","remaining_fraction":0.65,"reset_time":"2026-11-15T19:55:53Z"}]},` +
		`{"name":"Gemini 4 Argon","buckets":[{"id":"argon-weekly","name":"Gemini 4 Argon Weekly Limit","window":"monthly-ish","remaining_fraction":1,"reset_time":"2026-11-22T19:48:33Z"}]}]}}}`)
	var a Account
	if !parseAgy(&a, out) || len(a.Windows) != 3 {
		t.Fatalf("windows %+v", a.Windows)
	}
	w := a.Windows
	if w[0].Kind != KindWeekly || w[0].Label != "Gemini Models" || w[0].UsedPct < 14.9 || w[0].UsedPct > 15.1 || w[0].ResetsAt != 1795242164 {
		t.Errorf("weekly %+v", w[0])
	}
	if w[1].Kind != KindSession || w[1].WindowSec != 5*3600 {
		t.Errorf("session %+v", w[1])
	}
	if w[2].Kind != KindModel || w[2].Label != "Gemini 4 Argon Weekly Limit" || w[2].UsedPct != 0 {
		t.Errorf("model %+v", w[2])
	}
}

func TestParsePSOwnUserOnly(t *testing.T) {
	out := []byte("  0   10 /opt/antigravity/language_server_linux_x64 --csrf_token=root-tok\n" +
		"1001   20 /opt/antigravity/language_server_linux_x64 --csrf_token=other-tok\n" +
		"1000   30 /opt/antigravity/language_server_linux_x64 --csrf_token=mine\n" +
		"bad    40 /opt/antigravity/language_server_linux_x64 --csrf_token=junk\n")
	ps := parsePS(out, 1000)
	if len(ps) != 1 || ps[0].PID != 30 || ps[0].CSRF != "mine" {
		t.Errorf("processes %+v", ps)
	}
}

func TestNoRedirects(t *testing.T) {
	var followed bool
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		followed = true
		w.Write([]byte(`{}`))
	}))
	defer target.Close()
	api := newFakeAPI(t)
	api.replies["/user/balance"] = func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL+"/steal", http.StatusFound)
	}
	e := testEnv(t, api)
	e.Client = NewClient()
	e.Client.Transport.(*http.Transport).Proxy = nil
	e.Getenv = func(k string) string {
		if k == "DEEPSEEK_API_KEY" {
			return "sk-redirect"
		}
		return ""
	}
	a := one(t, Limits(context.Background(), e, Options{Providers: []string{DeepSeek}}))
	if followed || a.Status != StatusError || a.Code != "http_302" {
		t.Errorf("followed %v, account %+v", followed, a)
	}
}

func TestDeepSeekLookalikeGateway(t *testing.T) {
	api := newFakeAPI(t)
	api.json("/user/balance", `{"is_available":true}`)
	e := testEnv(t, api)
	for _, u := range []string{"https://deepseek.evil.example/anthropic", "https://api.deepseek.com.evil.example", "http://api.deepseek.com/anthropic", "https://notdeepseek.com/x", "https://user@evil.example@api.deepseek.com"} {
		write(t, filepath.Join(e.Home, ".claude/settings.json"), `{"env":{"ANTHROPIC_BASE_URL":"`+u+`","ANTHROPIC_AUTH_TOKEN":"sk-gateway"}}`)
		if a := one(t, Limits(context.Background(), e, Options{Providers: []string{DeepSeek}})); a.Status != StatusMissing {
			t.Errorf("%s: %+v", u, a)
		}
	}
	if api.asked("/user/balance") {
		t.Errorf("a gateway's token was sent")
	}
	for _, u := range []string{"https://api.deepseek.com/anthropic", "https://API.DeepSeek.com.", "https://eu.api.deepseek.com"} {
		if !isDeepSeekURL(u) {
			t.Errorf("%s refused", u)
		}
	}
}

func TestSkipLocal(t *testing.T) {
	api := newFakeAPI(t)
	e := testEnv(t, api)
	write(t, filepath.Join(e.Home, ".kimi-code/credentials/kimi-code.json"), `{"access_token":"opaque"}`)
	accs := Limits(context.Background(), e, Options{Providers: []string{Kimi}, SkipLocal: []string{"kimi"}})
	if a := one(t, accs); a.Status != StatusSkipped || api.asked("/coding/v1/usages") {
		t.Errorf("id-less account not skipped: %+v", a)
	}
}
