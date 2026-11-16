// Package usage reads what AI coding subscriptions have left on one
// machine: the rate-limit windows, credits and balances of the accounts the
// CLIs there are signed in to (Claude Code, Codex, Grok, Antigravity, Kimi
// Code, DeepSeek), and the token cost of the CLIs' local logs at API prices.
//
// It runs where the credentials are (the agent's plugin usage,
// internal/agent/plugin/usage): it reads the CLIs' credential files read
// only, never refreshes or writes them, asks the providers' fixed hosts over
// HTTPS and returns normalized numbers, an account id (a hash where the
// provider's id is a secret) and the account's email and plan. Tokens and
// keys never leave the machine. docs/features/29-ai-usage.md has the design.
package usage

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"math"
	"net/http"
	"os"
	"path"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Providers, in the order the UIs list them.
const (
	Claude      = "claude"
	Codex       = "codex"
	Grok        = "grok"
	Antigravity = "antigravity"
	Kimi        = "kimi"
	DeepSeek    = "deepseek"
)

// Providers lists every provider.
var Providers = []string{Claude, Codex, Grok, Antigravity, Kimi, DeepSeek}

// Status of an account.
const (
	StatusOK      = "ok"
	StatusStale   = "stale"   // credentials expired (run the CLI once) or numbers from a log
	StatusUnauth  = "unauth"  // the provider refused the credentials
	StatusError   = "error"   // the request failed (Code says why)
	StatusMissing = "missing" // no credentials of this provider on the machine
	// StatusSkipped: the core already has this account from another
	// machine (Options.Skip); only its identity is returned.
	StatusSkipped = "skipped"
)

// Window kinds.
const (
	KindSession = "session"
	KindWeekly  = "weekly"
	KindMonthly = "monthly"
	KindModel   = "model"
)

// Window is one rate-limit window of an account.
type Window struct {
	Kind  string `json:"kind"`
	Label string `json:"label,omitempty"`
	// UsedPct is how much of the window is used, 0–100.
	UsedPct float64 `json:"usedPct"`
	// ResetsAt is when the window starts over (Unix seconds, 0: unknown).
	ResetsAt int64 `json:"resetsAt,omitempty"`
	// WindowSec is the window's length (0: unknown).
	WindowSec int64 `json:"windowSec,omitempty"`
}

// Credits are a provider's credits or extra usage.
type Credits struct {
	// Balance left, when the provider says (USD unless Unit says else).
	Balance   *float64 `json:"balance,omitempty"`
	Used      *float64 `json:"used,omitempty"`
	Limit     *float64 `json:"limit,omitempty"`
	Unlimited bool     `json:"unlimited,omitempty"`
	Enabled   *bool    `json:"enabled,omitempty"`
	Unit      string   `json:"unit,omitempty"`
}

// Balance is a prepaid balance in one currency.
type Balance struct {
	Currency string  `json:"currency"`
	Total    float64 `json:"total"`
	Granted  float64 `json:"granted,omitempty"`
	ToppedUp float64 `json:"toppedUp,omitempty"`
}

// Account is what one provider says about one account on the machine.
type Account struct {
	Provider string `json:"provider"`
	// ID identifies the account across machines: the provider's account
	// id, or a hash of it (or of the key) where that is a secret; "" when
	// the machine has nothing that identifies it.
	ID       string    `json:"id,omitempty"`
	Email    string    `json:"email,omitempty"`
	Plan     string    `json:"plan,omitempty"`
	Windows  []Window  `json:"windows,omitempty"`
	Credits  *Credits  `json:"credits,omitempty"`
	Balances []Balance `json:"balances,omitempty"`
	// Available is false when a balance cannot pay for requests.
	Available *bool  `json:"available,omitempty"`
	Status    string `json:"status"`
	// Code says why the status is not ok: token_expired, http_<n>,
	// rate_limited, network, bad_response, keychain, from_log, not_running…
	Code string `json:"code,omitempty"`
	// Source is where the numbers come from: api, log (a CLI's log), ls
	// (a local language server) or cli.
	Source string `json:"source,omitempty"`
	// AsOf is when the numbers were current (Unix seconds).
	AsOf int64 `json:"asOf,omitempty"`
	// RetryAfter asks not to ask again for this many seconds (429).
	RetryAfter int64 `json:"retryAfter,omitempty"`
	// Home tells accounts of one provider apart on a machine (a Codex
	// home other than the default).
	Home string `json:"home,omitempty"`
}

// Options select what Limits reads.
type Options struct {
	// Providers to read (empty: all).
	Providers []string `json:"providers,omitempty"`
	// CodexHomes are Codex homes besides $CODEX_HOME or ~/.codex.
	CodexHomes []string `json:"codexHomes,omitempty"`
	// ClaudeKeychain lets Claude's credentials come from the macOS
	// keychain when the file has none.
	ClaudeKeychain bool `json:"claudeKeychain,omitempty"`
	// Skip are accounts (provider:id) the core already has, or holds back
	// after a provider asked to wait (Retry-After): they are returned with
	// StatusSkipped and asked nothing.
	Skip []string `json:"skip,omitempty"`
	// SkipLocal are this machine's accounts without an id that the core
	// holds back after a provider asked to wait: provider, or
	// provider:home for a Codex home other than the default.
	SkipLocal []string `json:"skipLocal,omitempty"`
}

// URLs are the providers' endpoints (tests point them at httptest servers).
type URLs struct {
	ClaudeUsage, ClaudeProfile string
	CodexUsage                 string
	GrokBilling, GrokSettings  string
	KimiUsage                  string
	DeepSeekBalance            string
}

// DefaultURLs are the providers' hosts; the only ones Limits talks to
// besides the local Antigravity language server (127.0.0.1).
var DefaultURLs = URLs{
	ClaudeUsage:     "https://api.anthropic.com/api/oauth/usage",
	ClaudeProfile:   "https://api.anthropic.com/api/oauth/profile",
	CodexUsage:      "https://chatgpt.com/backend-api/wham/usage",
	GrokBilling:     "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
	GrokSettings:    "https://cli-chat-proxy.grok.com/v1/settings",
	KimiUsage:       "https://api.kimi.com/coding/v1/usages",
	DeepSeekBalance: "https://api.deepseek.com/user/balance",
}

// Env is the machine as the providers see it.
type Env struct {
	Home string
	// Base is the agent's data directory (~/.<slug>[-<instance>]): the
	// DeepSeek key file and the cost cache are below Base/usage.
	Base    string
	Getenv  func(string) string
	Environ func() []string
	Client  *http.Client
	URLs    URLs
	Now     func() time.Time
	GOOS    string
	// Keychain returns a generic password of the macOS keychain.
	Keychain func(ctx context.Context, service string) (string, error)
	// Command runs a program with a timeout and returns its output
	// (Antigravity: ps, lsof, agy).
	Command func(ctx context.Context, env []string, name string, args ...string) ([]byte, error)
	// LookPath finds a program (agy).
	LookPath func(name string) (string, error)
	// UID is the agent's user: only its own language servers are asked.
	UID int
	// ProcRoot is /proc on Linux (tests point it at a fixture).
	ProcRoot string
	// LocalClient is the client for the local language server (its
	// self-signed certificate is accepted on 127.0.0.1 only).
	LocalClient func(port int) *http.Client
	// Memo keeps between calls what is costly to get again (agy's answer,
	// the newest Codex log's rate limits); nil keeps nothing.
	Memo *Memo
}

// processMemo is the Memo of the process's Envs.
var processMemo = &Memo{}

// NewEnv returns the machine's environment: home and data directory, the
// process environment, the process's HTTP client (HTTPS_PROXY, 15 s
// timeout) and memo.
func NewEnv(home, base string, environ func() []string) *Env {
	if environ == nil {
		environ = os.Environ
	}
	return &Env{
		Home: home, Base: base, Getenv: os.Getenv, Environ: environ,
		Client: sharedClient(), URLs: DefaultURLs, Now: time.Now, GOOS: runtime.GOOS,
		Keychain: keychain, Command: runCommand, LookPath: lookPath(environ), UID: os.Getuid(), ProcRoot: "/proc",
		LocalClient: localClient, Memo: processMemo,
	}
}

func (e *Env) now() time.Time {
	if e.Now == nil {
		return time.Now()
	}
	return e.Now()
}

func (e *Env) getenv(k string) string {
	if e.Getenv == nil {
		return ""
	}
	return e.Getenv(k)
}

// expand resolves ~ and makes p absolute relative to the home directory.
func (e *Env) expand(p string) string {
	if p == "~" {
		return e.Home
	}
	if strings.HasPrefix(p, "~/") {
		return path.Join(e.Home, p[2:])
	}
	if !path.IsAbs(p) {
		return path.Join(e.Home, p)
	}
	return p
}

// provider reads the accounts of one provider.
type provider func(ctx context.Context, e *Env, o *Options) []Account

var providers = map[string]provider{
	Claude:      claudeAccounts,
	Codex:       codexAccounts,
	Grok:        grokAccounts,
	Antigravity: antigravityAccounts,
	Kimi:        kimiAccounts,
	DeepSeek:    deepseekAccounts,
}

// Limits reads the accounts of the providers o selects, in parallel.
func Limits(ctx context.Context, e *Env, o Options) []Account {
	want := o.Providers
	if len(want) == 0 {
		want = Providers
	}
	results := make([][]Account, len(Providers))
	var wg sync.WaitGroup
	for i, p := range Providers {
		if !slices.Contains(want, p) {
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[i] = providers[p](ctx, e, &o)
		}()
	}
	wg.Wait()
	var out []Account
	for _, r := range results {
		out = append(out, r...)
	}
	for i := range out {
		if out[i].Windows == nil {
			out[i].Windows = []Window{}
		}
	}
	return out
}

// Key is how the core tells accounts apart across machines.
func (a Account) Key() string { return a.Provider + ":" + a.ID }

// skips tells whether an account is not to be asked: by its id, or, for
// one without an id, by provider and home (Options.SkipLocal).
func (o *Options) skips(provider, id, home string) bool {
	if id != "" {
		return slices.Contains(o.Skip, provider+":"+id)
	}
	k := provider
	if home != "" {
		k += ":" + home
	}
	return slices.Contains(o.SkipLocal, k)
}

// skipped is the answer for an account the core already has.
func skipped(a Account) Account {
	return Account{Provider: a.Provider, ID: a.ID, Email: a.Email, Plan: a.Plan, Status: StatusSkipped, Home: a.Home, Windows: []Window{}}
}

// HashID hashes an identifier that must not leave the machine as it is.
func HashID(s string) string {
	if s == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(s))
	return "h" + hex.EncodeToString(sum[:8])
}

// num reads a JSON number, or a number in a string; ok is false otherwise.
func num(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case json.Number:
		f, err := x.Float64()
		return f, err == nil
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(x), 64)
		return f, err == nil && !math.IsNaN(f) && !math.IsInf(f, 0)
	case int:
		return float64(x), true
	case int64:
		return float64(x), true
	}
	return 0, false
}

// timeOf reads a time: RFC 3339, or Unix seconds or milliseconds (also in
// a string); 0 when it is none.
func timeOf(v any) int64 {
	if s, ok := v.(string); ok {
		s = strings.TrimSpace(s)
		if s == "" {
			return 0
		}
		for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05", "2006-01-02 15:04:05"} {
			if t, err := time.Parse(layout, s); err == nil {
				return t.Unix()
			}
		}
	}
	f, ok := num(v)
	if !ok || f <= 0 {
		return 0
	}
	if f > 1e12 { // milliseconds
		f /= 1000
	}
	return int64(f)
}

func clampPct(p float64) float64 {
	if math.IsNaN(p) || p < 0 {
		return 0
	}
	if p > 100 {
		return 100
	}
	return math.Round(p*100) / 100
}

// obj and friends walk decoded JSON without panicking.
func obj(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

func arr(v any) []any {
	a, _ := v.([]any)
	return a
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

// first returns the first of keys present in m.
func first(m map[string]any, keys ...string) any {
	for _, k := range keys {
		if v, ok := m[k]; ok && v != nil {
			return v
		}
	}
	return nil
}

func boolPtr(b bool) *bool              { return &b }
func floatPtr(f float64) *float64       { return &f }
func readFile(p string) ([]byte, error) { return os.ReadFile(p) }
